const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');

class DriveService {
  constructor() {
    this.drive = null;
    this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    this.initialized = false;
  }

  /**
   * Initialize Google Drive client
   */
  async init() {
    if (this.initialized) return;

    try {
      if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
      }
      if (!this.folderId) {
        throw new Error('GOOGLE_DRIVE_FOLDER_ID not set');
      }

      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });

      this.drive = google.drive({ version: 'v3', auth });
      this.initialized = true;
      console.log('Google Drive service initialized');
    } catch (error) {
      console.error('Failed to initialize Google Drive:', error.message);
      throw error;
    }
  }

  /**
   * Upload a file to Google Drive
   * @param {string} filePath - Local file path
   * @param {string} fileName - Name for the file in Drive
   * @param {string} mimeType - File MIME type
   * @returns {object} - { fileId, webViewLink, webContentLink }
   */
  async uploadFile(filePath, fileName, mimeType = 'video/mp4') {
    await this.init();

    console.log(`Uploading to Google Drive: ${fileName}`);

    const fileMetadata = {
      name: fileName,
      parents: [this.folderId]
    };

    const media = {
      mimeType,
      body: fs.createReadStream(filePath)
    };

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, webViewLink, webContentLink'
    });

    // Make file publicly accessible
    await this.drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // Get the updated file with download link
    const file = await this.drive.files.get({
      fileId: response.data.id,
      fields: 'id, webViewLink, webContentLink'
    });

    console.log(`Uploaded: ${fileName} -> ${file.data.id}`);

    return {
      fileId: file.data.id,
      webViewLink: file.data.webViewLink,
      webContentLink: file.data.webContentLink,
      directLink: `https://drive.google.com/uc?export=download&id=${file.data.id}`
    };
  }

  /**
   * Upload multiple files to Google Drive
   * @param {Array} files - Array of { localPath, fileName, mimeType }
   * @returns {Array} - Array of upload results
   */
  async uploadFiles(files) {
    await this.init();

    const results = [];
    for (const file of files) {
      try {
        const result = await this.uploadFile(
          file.localPath,
          file.fileName,
          file.mimeType || 'video/mp4'
        );
        results.push({
          ...result,
          originalPath: file.localPath,
          fileName: file.fileName,
          success: true
        });
      } catch (error) {
        console.error(`Failed to upload ${file.fileName}:`, error.message);
        results.push({
          originalPath: file.localPath,
          fileName: file.fileName,
          success: false,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Create a subfolder in the main folder
   * @param {string} folderName - Name of the subfolder
   * @returns {string} - Folder ID
   */
  async createSubfolder(folderName) {
    await this.init();

    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [this.folderId]
    };

    const response = await this.drive.files.create({
      requestBody: fileMetadata,
      fields: 'id'
    });

    console.log(`Created subfolder: ${folderName} -> ${response.data.id}`);
    return response.data.id;
  }

  /**
   * Delete a file from Google Drive
   * @param {string} fileId - Google Drive file ID
   */
  async deleteFile(fileId) {
    await this.init();
    await this.drive.files.delete({ fileId });
    console.log(`Deleted file: ${fileId}`);
  }

  /**
   * Check if Drive is configured
   */
  isConfigured() {
    return !!(process.env.GOOGLE_SERVICE_ACCOUNT_KEY && process.env.GOOGLE_DRIVE_FOLDER_ID);
  }
}

module.exports = new DriveService();
