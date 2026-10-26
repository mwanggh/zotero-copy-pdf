"use strict";

var CopyPDF = {
  active: false,
  busy: false,
  menuID: null,
  process: null,

  text(key, values = {}) {
    const locale = String(Zotero.locale || "en-US")
      .replace(/_/g, "-")
      .toLowerCase();

    const language = locale.startsWith("zh") ? "zh" : "en";

    const messages = {
      zh: {
        title: "Zotero PDF 文件复制",
        menu: "复制 PDF 文件",
        copying: "正在复制 PDF 文件…",

        windowsOnly: "此版本仅支持 Windows。",

        noPDF:
          "没有找到可复制的本地 PDF。\n\n" +
          "请选择文献或 PDF 附件，并确认附件已下载且能正常打开。",

        failed:
          "复制失败：\n{message}",

        partialFailure:
          "有 {skipped} 个 PDF 附件因文件不存在或读取失败，" +
          "未能加入剪贴板。\n\n" +
          "其余 {count} 个文件已加入剪贴板，" +
          "可到目标文件夹按 Ctrl+V 粘贴。",

        timeout:
          "调用 Windows 剪贴板超时，请稍后重试。",

        noPowerShell:
          "找不到 Windows PowerShell。",

        noMenuAPI:
          "当前 Zotero 未提供所需的 MenuManager API。",

        startupFailed:
          "插件启动失败：\n{message}",

        menuRegistrationFailed:
          "无法注册“复制 PDF 文件”菜单。"
      },

      en: {
        title: "Zotero Copy PDF",
        menu: "Copy PDF Files",
        copying: "Copying PDF files…",

        windowsOnly:
          "This version supports Windows only.",

        noPDF:
          "No local PDF files were found.\n\n" +
          "Select items or PDF attachments and make sure " +
          "the files are downloaded and can be opened.",

        failed:
          "Copy failed:\n{message}",

        partialFailure:
          "{skipped} PDF attachment(s) could not be added " +
          "to the clipboard because they were missing or unreadable.\n\n" +
          "The other {count} file(s) are on the clipboard. " +
          "Press Ctrl+V in the destination folder to paste.",

        timeout:
          "The Windows clipboard operation timed out. Please try again.",

        noPowerShell:
          "Windows PowerShell was not found.",

        noMenuAPI:
          "The required MenuManager API is unavailable in this version of Zotero.",

        startupFailed:
          "Plugin startup failed:\n{message}",

        menuRegistrationFailed:
          "Could not register the Copy PDF Files menu."
      }
    };

    const template =
      messages[language][key] ??
      messages.en[key] ??
      key;

    return template.replace(
      /\{(\w+)\}/g,
      (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name)
          ? String(values[name])
          : match
    );
  },

  log(message) {
    Zotero.debug("[CopyPDF] " + message);
  },

  alert(win, message) {
    const parent = win && !win.closed ? win : null;
    Services.prompt.alert(parent, this.text("title"), message);
  },

  async start({ id }) {
    this.active = true;

    await Zotero.uiReadyPromise;

    if (!this.active) return;

    if (!Zotero.MenuManager) {
      throw new Error(this.text("noMenuAPI"));
    }

    if (this.menuID !== null) return;

    this.menuID = Zotero.MenuManager.registerMenu({
      menuID: "copy-local-pdf-files",
      pluginID: id,
      target: "main/library/item",

      menus: [
        {
          menuType: "menuitem",

          onShowing: (event, context) => {
            context.menuElem.label = this.text(
              this.busy ? "copying" : "menu"
            );

            const items = context.items || [];

            context.setVisible(true);
            context.setEnabled(
              this.active &&
              !this.busy &&
              items.some(
                item => item.isRegularItem() || item.isAttachment()
              )
            );
          },

          onCommand: (event, context) => {
            const win =
              context.menuElem?.ownerGlobal ||
              event.target?.ownerGlobal ||
              Zotero.getMainWindow();

            // 保存点击菜单这一刻的选择，避免异步过程中选择变化
            const items = Array.from(context.items || []);

            this.copySelectedPDFs(win, items).catch(error => {
              Zotero.logError(error);
            });
          }
        }
      ]
    });

    // 注册失败时不要输出虚假的成功日志
    if (!this.menuID) {
      this.menuID = null;
      throw new Error(this.text("menuRegistrationFailed"));
    }

    this.log(this.text("menuRegistrationSucceeded"));
  },

  stop() {
    this.active = false;

    if (this.menuID !== null) {
      try {
        Zotero.MenuManager.unregisterMenu(this.menuID);
      } catch (error) {
        Zotero.logError(error);
      }

      this.menuID = null;
    }

    if (this.process) {
      try {
        this.process.kill();
      } catch (error) {
        Zotero.logError(error);
      }

      this.process = null;
    }

    this.log("插件已关闭");
  },

  async collectPDFs(items) {
    // 按附件 ID 去重，避免父条目和子附件同时选中时重复处理
    const attachments = new Map();

    for (const item of items) {
      if (item.isRegularItem()) {
        const ids = item.getAttachments();

        for (const id of ids) {
          const attachment = await Zotero.Items.getAsync(id);

          if (attachment && !attachment.deleted) {
            attachments.set(attachment.id, attachment);
          }
        }
      } else if (item.isAttachment() && !item.deleted) {
        attachments.set(item.id, item);
      }
    }

    const paths = [];
    const seenPaths = new Set();
    let skipped = 0;

    for (const attachment of attachments.values()) {
      if (!this.active) break;

      // 只复制 Zotero 识别为 PDF 的附件
      if (attachment.attachmentContentType !== "application/pdf") {
        continue;
      }

      try {
        const path = await attachment.getFilePathAsync();

        if (!path) {
          skipped++;
          continue;
        }

        const file = Components.classes[
          "@mozilla.org/file/local;1"
        ].createInstance(Components.interfaces.nsIFile);

        file.initWithPath(path);

        if (!file.exists() || !file.isFile()) {
          skipped++;
          continue;
        }

        const normalizedPath = file.path;

        if (!seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          paths.push(normalizedPath);
        }
      } catch (error) {
        skipped++;
        Zotero.logError(error);
      }
    }

    return { paths, skipped };
  },

  async copySelectedPDFs(win, items) {
    if (!this.active || this.busy) return;

    this.busy = true;

    try {
      if (!Zotero.isWin) {
        throw new Error(this.text("windowsOnly"));
      }

      const { paths, skipped } = await this.collectPDFs(items);

      if (!this.active) return;

      if (!paths.length) {
        throw new Error(this.text("noPDF"));
      }

      await this.copyWindowsFiles(win, paths);

      if (!this.active) return;

      // 成功只写调试日志，不弹出窗口
      this.log(
        `Clipboard updated: ${paths.length} PDF file(s); ` +
        `${skipped} attachment(s) skipped.`
      );

      // 仅部分失败时提示，语言统一从 text() 获取
      if (skipped > 0) {
        this.alert(
          win,
          this.text("partialFailure", {
            skipped,
            count: paths.length
          })
        );
      }
    } catch (error) {
      Zotero.logError(error);

      if (this.active) {
        this.alert(
          win,
          this.text("failed", {
            message: error?.message || String(error)
          })
        );
      }
    } finally {
      this.busy = false;
    }
  },

  // PowerShell 的 -EncodedCommand 使用 UTF-16LE Base64
  encodePowerShell(win, script) {
    let binary = "";

    for (let i = 0; i < script.length; i++) {
      const code = script.charCodeAt(i);
      binary += String.fromCharCode(code & 0xff, code >>> 8);
    }

    return win.btoa(binary);
  },

  async readAll(pipe) {
    let output = "";

    while (true) {
      const chunk = await pipe.readString();
      if (!chunk) break;
      output += chunk;
    }

    return output;
  },

  async copyWindowsFiles(win, paths) {
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs"
    );

    const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
      "resource://gre/modules/Timer.sys.mjs"
    );

    const systemRoot = Services.env.get("SystemRoot");

    if (!systemRoot) {
      throw new Error(this.text("noPowerShell"));
    }

    const executable = Components.classes[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);

    executable.initWithPath(systemRoot);
    executable.append("System32");
    executable.append("WindowsPowerShell");
    executable.append("v1.0");
    executable.append("powershell.exe");

    if (!executable.exists()) {
      throw new Error(this.text("noPowerShell"));
    }

    /*
     * 路径通过标准输入中的 JSON 传递，不拼接进 PowerShell 代码。
     * 这样中文、空格、引号等不会被当作命令执行。
     *
     * SetFileDropList 写入真正的文件列表，而不是路径文本。
     */
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    Add-Type -AssemblyName System.Windows.Forms

    # 标准输入只能读取一次
    $json = [Console]::In.ReadToEnd()

    if ([string]::IsNullOrWhiteSpace($json)) {
        throw 'No file list was received from Zotero.'
    }

    # 不在外层额外添加 @(...)
    $paths = ConvertFrom-Json -InputObject $json

    $files = New-Object System.Collections.Specialized.StringCollection

    foreach ($path in $paths) {
        if ($path -isnot [string]) {
            throw 'Invalid file path: expected a string.'
        }

        if ([string]::IsNullOrWhiteSpace($path)) {
            throw 'An empty file path was received.'
        }

        if (-not [System.IO.File]::Exists($path)) {
            throw "File no longer exists: $path"
        }

        [void]$files.Add($path)
    }

    if ($files.Count -eq 0) {
        throw 'No files to copy.'
    }

    $done = $false

    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            [System.Windows.Forms.Clipboard]::SetFileDropList($files)
            $done = $true
            break
        }
        catch {
            if ($attempt -eq 4) {
                throw
            }

            Start-Sleep -Milliseconds 200
        }
    }

    if (-not $done) {
        throw 'Could not write to clipboard.'
    }

    [Console]::Out.Write('OK')
    exit 0
}
catch {
    [Console]::Out.Write($_.Exception.ToString())
    exit 1
}
`;

    const encoded = this.encodePowerShell(win, script);

    // 转成纯 ASCII JSON，避免 PowerShell 标准输入编码影响中文路径。
    // JSON 解析后会还原 Unicode 字符。
    const input = JSON.stringify(paths).replace(
      /[\u007f-\uffff]/g,
      char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")
    );

    const proc = await Subprocess.call({
      command: executable.path,
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded
      ],
      stderr: "stdout"
    });

    this.process = proc;

    if (!this.active) {
      proc.kill();
      this.process = null;
      throw new Error("Plugin was disabled");
    }

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;

      try {
        proc.kill();
      } catch (error) {
        Zotero.logError(error);
      }
    }, 30000);

    try {
      // 同时读输出和写输入，避免管道阻塞
      const outputPromise = this.readAll(proc.stdout);

      const inputPromise = (async () => {
        await proc.stdin.write(input);
        await proc.stdin.close();
      })();

      const [output, , result] = await Promise.all([
        outputPromise,
        inputPromise,
        proc.wait()
      ]);

      if (timedOut) {
        throw new Error(this.text("timeout"));
      }

      if (result.exitCode !== 0 || output.trim() !== "OK") {
        throw new Error(
          output.trim() ||
          "PowerShell exited with code " + result.exitCode
        );
      }
    } catch (error) {
      try {
        proc.kill();
      } catch (_) {
        // 进程可能已经结束
      }

      if (timedOut) {
        throw new Error(this.text("timeout"));
      }

      throw error;
    } finally {
      clearTimeout(timer);

      if (this.process === proc) {
        this.process = null;
      }
    }
  }
};

function install() {}

function uninstall() {}

async function startup(data, reason) {
  try {
    await CopyPDF.start(data);
  } catch (error) {
    Zotero.logError(error);

    CopyPDF.log(
      "Startup failed: " + (error?.message || String(error))
    );

    if (CopyPDF.active) {
      CopyPDF.alert(
        Zotero.getMainWindow(),
        CopyPDF.text("startupFailed", {
          message: error?.message || String(error)
        })
      );
    }
  }
}


function shutdown(data, reason) {
  CopyPDF.stop();
}