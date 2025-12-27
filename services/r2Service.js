const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');

class R2Service {
  constructor() {
    this.client = null;
    this.bucketName = process.env.R2_BUCKET_NAME;
    this.publicUrl = process.env.R2_PUBLIC_URL;
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
   * Download a file from R2 public URL
   */
  async downloadFile(url, localPath) {
    console.log(`Downloading from R2: ${url}`);
    
    await fs.ensureDir(path.dirname(localPath));
    
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      
      const file = fs.createWriteStream(localPath);
      
      protocol.get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          // Handle redirect
          this.downloadFile(response.headers.location, localPath)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          console.log(`✓ Downloaded: ${path.basename(localPath)}`);
          resolve(localPath);
        });
        
        file.on('error', (err) => {
          fs.unlink(localPath).catch(() => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(localPath).catch(() => {});
        reject(err);
      });
    });
  }

  /**
   * Download manifest and clips for a split job
   */
  async downloadSplitJob(jobId, targetDir) {
    console.log(`\nDownloading split job ${jobId} from R2...`);
    
    const manifestUrl = `${this.publicUrl}/splits/${jobId}/manifest.json`;
    const clipsDir = path.join(targetDir, 'clips');
    
    await fs.ensureDir(clipsDir);
    
    // Download manifest
    const manifestPath = path.join(targetDir, 'manifest.json');
    
    try {
      await this.downloadFile(manifestUrl, manifestPath);
    } catch (err) {
      console.error(`Failed to download manifest: ${err.message}`);
      throw new Error(`Split job ${jobId} not found in R2 storage`);
    }
    
    // Read manifest
    const manifest = await fs.readJson(manifestPath);
    console.log(`Manifest loaded: ${manifest.totalClips} clips`);
    
    // Download each clip
    for (const clip of manifest.clips) {
      if (clip.r2Link) {
        const clipPath = path.join(clipsDir, `clip_${clip.number}.mp4`);
        try {
          await this.downloadFile(clip.r2Link, clipPath);
        } catch (err) {
          console.error(`Failed to download clip ${clip.number}: ${err.message}`);
        }
      }
    }
    
    console.log(`✓ Split job ${jobId} restored from R2`);
    return manifest;
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
