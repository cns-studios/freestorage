const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    login: (credentials) => ipcRenderer.invoke('login', credentials),
    register: (credentials) => ipcRenderer.invoke('register', credentials),
    uploadFile: (filePath) => ipcRenderer.invoke('upload-file', filePath),
    downloadFile: (fileId) => ipcRenderer.invoke('download-file', fileId),
    renameFile: (fileId, newFilename) => ipcRenderer.invoke('rename-file', { fileId, newFilename }),
    deleteFile: (fileId) => ipcRenderer.invoke('delete-file', fileId),
    getFiles: (userId) => ipcRenderer.invoke('get-files', userId),
    getProfile: (token) => ipcRenderer.invoke('get-profile', token),
    updateAccount: (data) => ipcRenderer.invoke('update-account', data),
    deleteAccount: () => ipcRenderer.invoke('delete-account'),
    deleteAllFiles: (userId) => ipcRenderer.invoke('delete-all-files', userId),
    onUploadProgress: (callback) => ipcRenderer.on('upload-progress', (event, data) => callback(data)),
    cancelUpload: () => ipcRenderer.invoke('cancel-upload'),
    
    checkAuth: () => ipcRenderer.invoke('check-auth'),
    logout: () => ipcRenderer.invoke('logout'),
    minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
    closeWindow: () => ipcRenderer.invoke('window-close'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    
    onUpdateChecking: (cb) => ipcRenderer.on('update-checking', cb),
    onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, info) => cb(info)),
    onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', (e, info) => cb(info)),
    onUpdateError: (cb) => ipcRenderer.on('update-error', (e, err) => cb(err)),
    onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, progress) => cb(progress)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (e, info) => cb(info))
});
