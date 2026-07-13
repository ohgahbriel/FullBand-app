// Minimal, safe bridge so the web UI (loaded from localhost) can trigger the
// GPU upgrade in the Electron main process and receive progress lines.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fullband", {
  isDesktop: true,
  enableGpu: () => ipcRenderer.invoke("fullband:enable-gpu"),
  onGpuProgress: (cb) =>
    ipcRenderer.on("fullband:gpu-progress", (_e, line) => cb(line)),
});
