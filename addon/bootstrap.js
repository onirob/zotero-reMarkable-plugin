/*
 * Firefox/Zotero bootstrap entry points for reMarkable Sync for Zotero.
 * The build fills in the double-underscore placeholders from package.json.
 * Empty entry points are still part of the bootstrap API.
 */

let chromeRegistration;

function install() {}

function pickComparisonFile(win, extension, save = false) {
  const { nsIFilePicker } = Components.interfaces;
  const picker =
    Components.classes["@mozilla.org/filepicker;1"].createInstance(
      nsIFilePicker,
    );
  picker.init(
    win.browsingContext,
    save
      ? "Save a tablet comparison file"
      : "Select the PDF saved before editing",
    save ? nsIFilePicker.modeSave : nsIFilePicker.modeOpen,
  );
  picker.appendFilter(
    extension === "rm" ? "reMarkable pages" : "PDF files",
    `*.${extension}`,
  );
  picker.defaultExtension = extension;
  if (save) picker.defaultString = `reMarkable-comparison.${extension}`;
  picker.addToRecentDocs = false;
  return new Promise((resolve) => {
    picker.open((result) =>
      resolve(
        result === nsIFilePicker.returnOK ? picker.file?.path : undefined,
      ),
    );
  });
}

async function startup({ rootURI }) {
  const addonManager = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  // Makes chrome://__addonRef__/content/ point at the add-on's content/ folder.
  chromeRegistration = addonManager.registerChrome(
    Services.io.newURI(`${rootURI}manifest.json`),
    [["content", "__addonRef__", `${rootURI}content/`]],
  );
  // The bundle registers the plugin as Zotero.__addonInstance__.
  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/__addonRef__.js`,
    {
      credentialManager: Services.logins,
      reviewPrompt: Services.prompt,
      pickComparisonFile,
      createCloudTimeoutSignal: (milliseconds) => {
        // The plugin scope has fetch but may lack window Web APIs.
        const Signal =
          Zotero.getMainWindow()?.AbortSignal ??
          Services.appShell.hiddenDOMWindow.AbortSignal;
        return Signal.timeout(milliseconds);
      },
      newCredential: () =>
        Components.classes[
          "@mozilla.org/login-manager/loginInfo;1"
        ].createInstance(Components.interfaces.nsILoginInfo),
    },
  );
  await Zotero.__addonInstance__.startup(rootURI);
}

function onMainWindowLoad({ window }) {
  Zotero.__addonInstance__?.onMainWindowLoad(window);
}

function onMainWindowUnload() {}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  Zotero.__addonInstance__?.shutdown();
  chromeRegistration?.destruct();
  chromeRegistration = undefined;
}

function uninstall() {}
