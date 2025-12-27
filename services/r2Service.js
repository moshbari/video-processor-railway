const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs-extra');
const path = require('path');

class R2Service {
  constructor() {
    this.client = null;
    this.bucketName = process.env.R2_BUCKET_NAME;
    this.publicUrl = process.env.R2_PUBLIC_URL; // Optional custom domain
    this.initialized = false;
  }

  /**
   * Initialize R2 client
   */
  init() {
    if (this.initialized) return;

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey || !this.bucketName) {
      console.log('R2 not configured - missing environment variables');
      return;
    }

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    });

    this.initialized = true;
    console.log('R2 storage service initialized');
  }

  /**
   * Upload a file to R2
   */
  async uploadFile(filePath, fileName, mimeType = 'video/mp4') {
    this.init();
    
    if (!this.client) {
      throw new Error('R2 not configured');
    }

    console.log(`Uploading to R2: ${fileName}`);

    const fileContent = await fs.readFile(filePath);
    
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileName,
      Body: fileContent,
      ContentType: mimeType
    });

    await this.client.send(command);

    // Generate public URL
    const downloadUrl = this.publicUrl 
      ? `${this.publicUrl}/${fileName}`
      : `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev/${fileName}`;

    console.log(`✓ Uploaded: ${fileName}`);

    return {
      fileName,
      downloadUrl,
      success: true
    };
  }

  /**
   * Upload multiple files to R2
   */
  async uploadFiles(files) {
    this.init();

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
   * Delete a file from R2
   */
  async deleteFile(fileName) {
    this.init();
    
    if (!this.client) return;

    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: fileName
    });

    await this.client.send(command);
    console.log(`Deleted from R2: ${fileName}`);
  }

  /**
   * Check if R2 is configured
   */
  isConfigured() {
    return !!(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME
    );
  }
}

module.exports = new R2Service();
