// Bridge between the music window's UI and the main process (contextIsolation on, no Node in the page).
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);
const api = {};
for (const ch of ['lib:get', 'lib:scan', 'lib:addFolder', 'lib:addFiles', 'lib:addPaths', 'lib:removeFolder', 'lib:update', 'lib:editTags', 'lib:setArtwork',
  'lib:remove', 'lib:played', 'lib:skipped', 'lib:setPlaylists', 'lib:setSettings', 'lib:show', 'lib:openFolder',
  'dev:list', 'dev:refresh', 'dev:settings', 'dev:plan', 'dev:sync', 'dev:cancel', 'dev:phoneMusic', 'dev:delete', 'dev:import', 'dev:preview',
  'app:pane', 'app:rect', 'app:office', 'app:launch', 'app:win', 'app:google', 'app:external', 'app:logs'])
  api[ch.replace(/:(\w)/, (_, c) => c.toUpperCase())] = call(ch);
api.on = (ch, f) => { const l = (_e, d) => f(d); ipcRenderer.on(ch, l); return () => ipcRenderer.removeListener(ch, l); };
// paths of files dropped on the window (File.path in Electron 22)
api.filePath = f => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : f.path);
contextBridge.exposeInMainWorld('vk', api);
