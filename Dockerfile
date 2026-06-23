FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (-U fetches the latest and busts this cached layer; a stale
# yt-dlp is the #1 cause of social-media download failures)
RUN pip3 install --break-system-packages -U yt-dlp

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p /app/temp /app/uploads /app/outputs

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
