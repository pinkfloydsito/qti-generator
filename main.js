import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import log from 'electron-log/main.js';

import PDFExtractor from './src/pdf-extractor.js';
import LLMService from './src/llm-service-v2.js';

// Configure logging
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

const extractor = new PDFExtractor();
const llmService = new LLMService();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let isQuitting = false;

// Handle installer/uninstaller quit commands BEFORE app initialization
function handleQuitCommand() {
  const args = process.argv.slice(1);
  log.info('Process arguments:', args);

  if (args.includes('--quit') ||
    args.includes('--squirrel-uninstall') ||
    args.includes('--uninstall')) {
    log.info('Quit command detected, shutting down immediately');

    // Force quit without creating any windows
    setImmediate(() => {
      if (mainWindow) {
        mainWindow.destroy();
      }
      app.quit();
      process.exit(0);
    });
    return true;
  }
  return false;
}

// Check for quit command early
if (handleQuitCommand()) {
  // Exit early if quit command detected
  process.exit(0);
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.info('Another instance is running, quitting');
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    log.info('Second instance attempt:', commandLine);

    // Check if second instance has quit command
    if (commandLine.includes('--quit')) {
      log.info('Quit command from second instance');
      gracefulQuit();
      return;
    }

    // Otherwise focus main window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  // Don't create window if quitting
  if (isQuitting) return;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'logo.ico')
  });

  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (!isQuitting) {
      mainWindow.show();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Assessment',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('new-assessment');
            }
          }
        },
        {
          label: 'Open Assessment',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (!mainWindow) return;

            try {
              const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openFile'],
                filters: [
                  { name: 'JSON Files', extensions: ['json'] }
                ]
              });

              if (!result.canceled) {
                mainWindow.webContents.send('open-assessment', result.filePaths[0]);
              }
            } catch (error) {
              log.error('Error opening file dialog:', error);
            }
          }
        },
        {
          label: 'Save Assessment',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('save-assessment');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Export QTI',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('export-qti');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            gracefulQuit();
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function gracefulQuit() {
  log.info('Graceful quit initiated');
  isQuitting = true;

  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    try {
      mainWindow.close();
    } catch (error) {
      log.error('Error closing main window:', error);
      mainWindow.destroy();
    }
  }

  // Force quit after short delay
  setTimeout(() => {
    log.info('Force quitting application');
    app.quit();
    process.exit(0);
  }, 1000);
}

// Enhanced error handling wrapper
const safeHandler = (handler) => async (...args) => {
  try {
    return await handler(...args);
  } catch (error) {
    log.error('Handler error:', error);
    return { success: false, error: error.message };
  }
};

// IPC Handlers
ipcMain.handle('save-file', safeHandler(async (event, data, defaultPath) => {
  if (!mainWindow) throw new Error('No main window available');

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath,
    filters: [
      { name: 'QTI Files', extensions: ['xml'] },
      { name: 'JSON Files', extensions: ['json'] }
    ]
  });

  if (!result.canceled) {
    fs.writeFileSync(result.filePath, data, 'utf8');
    return { success: true, filePath: result.filePath };
  }

  return { success: false, canceled: true };
}));

ipcMain.handle('load-file', safeHandler(async (event, filePath) => {
  const data = fs.readFileSync(filePath, 'utf8');
  return { success: true, data };
}));

ipcMain.handle('export-qti', safeHandler(async (event, qtiXML) => {
  if (!mainWindow) throw new Error('No main window available');

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'assessment.xml',
    filters: [
      { name: 'QTI Files', extensions: ['xml'] },
      { name: 'XML Files', extensions: ['xml'] }
    ]
  });

  if (!result.canceled) {
    fs.writeFileSync(result.filePath, qtiXML, 'utf8');
    return { success: true, filePath: result.filePath };
  }

  return { success: false, canceled: true };
}));

ipcMain.handle('save-assessment', safeHandler(async (event, assessmentData) => {
  if (!mainWindow) throw new Error('No main window available');

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'assessment.json',
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ]
  });

  if (!result.canceled) {
    const jsonData = JSON.stringify(assessmentData, null, 2);
    fs.writeFileSync(result.filePath, jsonData, 'utf8');
    return { success: true, filePath: result.filePath };
  }

  return { success: false, canceled: true };
}));

ipcMain.handle('load-assessment', safeHandler(async (event) => {
  if (!mainWindow) throw new Error('No main window available');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const data = fs.readFileSync(result.filePaths[0], 'utf8');
    const assessment = JSON.parse(data);
    return { success: true, assessment };
  }

  return { success: false, canceled: true };
}));

ipcMain.handle('select-pdf-file', safeHandler(async (event) => {
  if (!mainWindow) throw new Error('No main window available');

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'PDF Files', extensions: ['pdf'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return { success: true, filePath: result.filePaths[0] };
  }

  return { success: false, canceled: true };
}));

ipcMain.handle('extract-pdf-text', safeHandler(async (_, arrayBuffer) => {
  const buffer = Buffer.from(arrayBuffer);
  log.info('Extracting text from PDF buffer of size:', buffer.length);
  return await extractor.extractText(buffer);
}));

// LLM Service handlers
ipcMain.handle('configure-llm', safeHandler(async (_, provider, apiKey) => {
  await llmService.setProvider(provider, apiKey);
  return { success: true };
}));

ipcMain.handle('test-api-key', safeHandler(async (_, provider, apiKey) => {
  const isValid = await llmService.testApiKey(provider, apiKey);
  return { success: true, isValid };
}));

ipcMain.handle('generate-questions', safeHandler(async (_, context, options) => {
  const questions = await llmService.generateQuestions(context, options);
  return { success: true, questions };
}));

ipcMain.handle('get-cached-api-key', safeHandler(async (_, provider) => {
  const apiKey = llmService.getCachedApiKey(provider);
  return { success: true, apiKey };
}));

// App lifecycle management
app.whenReady().then(() => {
  // Double-check for quit command after app is ready
  if (handleQuitCommand()) {
    return;
  }

  createWindow();
  createMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    gracefulQuit();
  }
});

app.on('before-quit', (event) => {
  log.info('Before quit event');
  isQuitting = true;
});

app.on('will-quit', (event) => {
  log.info('Will quit event');
});

// Handle process signals for graceful shutdown
process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully');
  gracefulQuit();
});

process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully');
  gracefulQuit();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  gracefulQuit();
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
});
