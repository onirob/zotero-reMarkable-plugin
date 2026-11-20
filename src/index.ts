/** Bundle entry point, loaded by addon/bootstrap.js. */
import pkg from "../package.json";
import { plugin } from "./plugin";

const { config } = pkg;

(Zotero as any)[config.addonInstance] ??= plugin;
