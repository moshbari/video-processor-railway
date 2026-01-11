/**
 * Project Metadata Service
 * 
 * Stores and retrieves project metadata from R2 bucket.
 * Projects are stored in a single JSON file: projects/single-reaction.json
 * 
 * This persists across server restarts since it's stored in R2!
 */

const r2Service = require('./r2Service');
const { v4: uuidv4 } = require('uuid');

// R2 key for the metadata file
const METADATA_KEY = 'projects/single-reaction-metadata.json';

class ProjectMetadataService {
  constructor() {
    this.cache = null;
    this.cacheTimestamp = null;
    this.cacheTTL = 60000; // 1 minute cache
  }

  /**
   * Load all projects from R2
   */
  async loadProjects() {
    try {
      // Check cache first
      if (this.cache && this.cacheTimestamp && (Date.now() - this.cacheTimestamp < this.cacheTTL)) {
        console.log('Using cached projects');
        return this.cache;
      }

      console.log('Loading projects from R2...');
      const data = await r2Service.getFile(METADATA_KEY);
      
      if (data) {
        const jsonString = data.toString('utf-8');
        this.cache = JSON.parse(jsonString);
        this.cacheTimestamp = Date.now();
        console.log(`Loaded ${this.cache.projects?.length || 0} projects from R2`);
        return this.cache;
      }
    } catch (error) {
      // File doesn't exist yet, that's OK
      if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey' || error.message?.includes('NoSuchKey')) {
        console.log('No metadata file found, starting fresh');
      } else {
        console.error('Error loading projects:', error.message);
      }
    }

    // Return default structure
    return {
      version: 1,
      projects: [],
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Save all projects to R2
   */
  async saveProjects(metadata) {
    try {
      metadata.lastUpdated = new Date().toISOString();
      
      const jsonString = JSON.stringify(metadata, null, 2);
      const buffer = Buffer.from(jsonString, 'utf-8');
      
      await r2Service.uploadBuffer(buffer, METADATA_KEY, 'application/json');
      
      // Update cache
      this.cache = metadata;
      this.cacheTimestamp = Date.now();
      
      console.log(`Saved ${metadata.projects?.length || 0} projects to R2`);
      return true;
    } catch (error) {
      console.error('Error saving projects:', error);
      throw error;
    }
  }

  /**
   * Add a new project
   */
  async addProject(projectData) {
    const metadata = await this.loadProjects();
    
    const project = {
      id: projectData.jobId || uuidv4(),
      title: projectData.title || `Project_${Date.now()}`,
      layoutMode: projectData.layoutMode || 'watchReact',
      layoutModeName: projectData.layoutModeName || (projectData.layoutMode === 'faceCam' ? 'Face Cam' : 'Watch & React'),
      pipPosition: projectData.pipPosition || 'top-right',
      pipScale: projectData.pipScale || 35,
      mainDuration: projectData.mainDuration,
      reactionDuration: projectData.reactionDuration,
      totalDuration: projectData.totalDuration,
      frozenFrameDuration: projectData.frozenFrameDuration || 0,
      fileSize: projectData.fileSize,
      fileSizeMB: projectData.fileSizeMB,
      r2Key: projectData.r2Key,
      downloadUrl: projectData.downloadUrl,
      createdAt: new Date().toISOString(),
      expiresAt: this.calculateExpiry() // 7 days from now
    };

    // Add to beginning of array (newest first)
    metadata.projects.unshift(project);

    // Keep only last 100 projects
    if (metadata.projects.length > 100) {
      metadata.projects = metadata.projects.slice(0, 100);
    }

    await this.saveProjects(metadata);
    
    console.log(`Project added: ${project.id} - ${project.title}`);
    return project;
  }

  /**
   * Calculate expiry date (7 days from now)
   */
  calculateExpiry() {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);
    return expiry.toISOString();
  }

  /**
   * Get all projects (with optional filtering)
   */
  async getProjects(options = {}) {
    const metadata = await this.loadProjects();
    let projects = metadata.projects || [];

    // Filter out expired projects
    if (options.excludeExpired !== false) {
      const now = new Date();
      projects = projects.filter(p => {
        if (!p.expiresAt) return true;
        return new Date(p.expiresAt) > now;
      });
    }

    // Limit results
    if (options.limit && options.limit > 0) {
      projects = projects.slice(0, options.limit);
    }

    return projects;
  }

  /**
   * Get a single project by ID
   */
  async getProject(projectId) {
    const metadata = await this.loadProjects();
    const project = metadata.projects?.find(p => p.id === projectId);
    
    if (!project) {
      return null;
    }

    // Check if expired
    if (project.expiresAt && new Date(project.expiresAt) < new Date()) {
      return { ...project, expired: true };
    }

    return project;
  }

  /**
   * Delete a project by ID
   */
  async deleteProject(projectId) {
    const metadata = await this.loadProjects();
    
    const index = metadata.projects?.findIndex(p => p.id === projectId);
    
    if (index === -1 || index === undefined) {
      return false;
    }

    const deleted = metadata.projects.splice(index, 1)[0];
    await this.saveProjects(metadata);
    
    console.log(`Project deleted: ${projectId}`);
    return deleted;
  }

  /**
   * Update a project
   */
  async updateProject(projectId, updates) {
    const metadata = await this.loadProjects();
    
    const index = metadata.projects?.findIndex(p => p.id === projectId);
    
    if (index === -1 || index === undefined) {
      return null;
    }

    metadata.projects[index] = {
      ...metadata.projects[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await this.saveProjects(metadata);
    
    return metadata.projects[index];
  }

  /**
   * Clean up expired projects
   */
  async cleanupExpired() {
    const metadata = await this.loadProjects();
    const now = new Date();
    
    const before = metadata.projects?.length || 0;
    
    metadata.projects = metadata.projects?.filter(p => {
      if (!p.expiresAt) return true;
      return new Date(p.expiresAt) > now;
    }) || [];
    
    const after = metadata.projects.length;
    
    if (before !== after) {
      await this.saveProjects(metadata);
      console.log(`Cleaned up ${before - after} expired projects`);
    }
    
    return before - after;
  }

  /**
   * Clear cache (force reload from R2)
   */
  clearCache() {
    this.cache = null;
    this.cacheTimestamp = null;
  }
}

module.exports = new ProjectMetadataService();
