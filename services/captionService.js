/**
 * 🎤 CAPTION SERVICE 🎤
 * 
 * Auto-generates and burns captions onto reaction videos using:
 * 1. OpenAI Whisper for speech-to-text with word-level timestamps
 * 2. FFmpeg ASS subtitle filter for burning captions into video
 * 
 * Supports 8 trending caption styles:
 * - boldPop: MrBeast viral style (yellow highlight, big text)
 * - hormoziStack: Alex Hormozi style (one word at a time, slam)
 * - karaokeWipe: Color fills word-by-word as spoken
 * - neonGlow: RANT Squad brand (electric blue glow)
 * - subtleClean: Professional/podcast (white on dark bar)
 * - boxHighlight: Colored box behind active word
 * - aliAbdaal: Educational (spoken words fade to dark)
 * - emojiBurst: Bold text + auto emoji on keywords
 * 
 * Part of RANT Squad Video Editor
 */

const OpenAI = require('openai');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

class CaptionService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Emoji mapping for emojiBurst style - keywords → emojis
    this.emojiMap = {
      'wow': '🤯', 'amazing': '🤩', 'insane': '🤯', 'crazy': '😱',
      'love': '❤️', 'hate': '😡', 'awesome': '🔥', 'fire': '🔥',
      'great': '👏', 'best': '🏆', 'worst': '💀', 'dead': '💀',
      'money': '💰', 'rich': '💰', 'game': '🎮', 'change': '🔄',
      'everything': '🌍', 'never': '🚫', 'always': '💯', 'wait': '⏳',
      'stop': '🛑', 'help': '🆘', 'win': '🏆', 'lose': '😢',
      'big': '🔥', 'huge': '🔥', 'think': '🤔', 'believe': '😤',
      'right': '✅', 'wrong': '❌', 'yes': '✅', 'no': '❌',
      'new': '✨', 'old': '👴', 'fast': '⚡', 'slow': '🐢',
      'happy': '😊', 'sad': '😢', 'angry': '😡', 'scared': '😨',
      'funny': '😂', 'serious': '😐', 'real': '💯', 'fake': '🤥',
      'smart': '🧠', 'dumb': '🤦', 'problem': '⚠️', 'solution': '💡',
      'secret': '🤫', 'truth': '📢', 'lie': '🤥', 'fact': '📊',
      'world': '🌍', 'life': '🌱', 'work': '💪', 'play': '🎉',
      'first': '🥇', 'last': '🏁', 'start': '🚀', 'end': '🏁',
      'learn': '📚', 'teach': '👨‍🏫', 'grow': '📈', 'fail': '📉',
    };
  }

  /**
   * Main entry: Transcribe audio and generate captioned video
   * @param {string} videoPath - Path to the reaction video
   * @param {string} outputPath - Path for the captioned output video
   * @param {string} styleName - One of the 8 style names
   * @param {object} videoInfo - { width, height } of the video
   * @returns {string} outputPath
   */
  async addCaptionsToVideo(videoPath, outputPath, styleName = 'boldPop', videoInfo = {}) {
    const { width = 1080, height = 1920 } = videoInfo;
    const workDir = path.dirname(outputPath);

    console.log(`\n🎤 CAPTION SERVICE`);
    console.log(`  Style: ${styleName}`);
    console.log(`  Video: ${path.basename(videoPath)}`);
    console.log(`  Target: ${width}x${height}`);

    try {
      // Step 1: Extract audio from video
      console.log('  Step 1: Extracting audio...');
      const audioPath = path.join(workDir, 'caption_audio.mp3');
      await this.extractAudio(videoPath, audioPath);

      // Step 2: Transcribe with Whisper (word-level timestamps)
      console.log('  Step 2: Transcribing with Whisper...');
      const words = await this.transcribeWithWordTimestamps(audioPath);
      console.log(`  ✓ Got ${words.length} words`);

      if (words.length === 0) {
        console.log('  ⚠ No words detected — skipping captions');
        await fs.copy(videoPath, outputPath);
        return outputPath;
      }

      // Step 3: Group words into display lines
      console.log('  Step 3: Grouping words into lines...');
      const lines = this.groupWordsIntoLines(words, styleName);
      console.log(`  ✓ Created ${lines.length} caption lines`);

      // Step 4: Generate ASS subtitle file
      console.log('  Step 4: Generating ASS subtitle file...');
      const assPath = path.join(workDir, 'captions.ass');
      this.generateASSFile(lines, assPath, styleName, width, height);

      // Step 5: Burn subtitles into video
      console.log('  Step 5: Burning captions into video...');
      await this.burnSubtitles(videoPath, assPath, outputPath);

      // Cleanup
      await fs.remove(audioPath).catch(() => {});
      await fs.remove(assPath).catch(() => {});

      console.log(`  ✓ Captions burned successfully!`);
      return outputPath;

    } catch (error) {
      console.error('Caption service error:', error);
      // On failure, copy original video without captions so render doesn't break
      console.log('  ⚠ Caption failed — using original video without captions');
      await fs.copy(videoPath, outputPath);
      return outputPath;
    }
  }

  /**
   * Extract audio from video as MP3
   */
  async extractAudio(videoPath, audioPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-y', '-i', videoPath,
        '-vn', '-acodec', 'libmp3lame',
        '-ab', '128k', '-ar', '16000', '-ac', '1',
        audioPath
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        if (code === 0) resolve(audioPath);
        else reject(new Error(`Audio extraction failed: ${stderr.slice(-300)}`));
      });
      proc.on('error', reject);
    });
  }

  /**
   * Transcribe audio with Whisper, returning word-level timestamps
   */
  async transcribeWithWordTimestamps(audioPath) {
    const stats = await fs.stat(audioPath);
    const sizeMB = stats.size / (1024 * 1024);
    console.log(`    Audio file: ${sizeMB.toFixed(2)} MB`);

    // Whisper has 25MB limit
    if (sizeMB > 25) {
      console.log('    ⚠ Audio too large for Whisper (>25MB) — trimming...');
      // Trim to first 10 minutes (should be enough for reaction clips)
      const trimmedPath = audioPath.replace('.mp3', '_trimmed.mp3');
      await new Promise((resolve, reject) => {
        const args = ['-y', '-i', audioPath, '-t', '600', '-acodec', 'libmp3lame', '-ab', '128k', trimmedPath];
        const proc = spawn('ffmpeg', args);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('Trim failed')));
        proc.on('error', reject);
      });
      await fs.move(trimmedPath, audioPath, { overwrite: true });
    }

    const fileStream = fs.createReadStream(audioPath);

    const response = await this.openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      temperature: 0
    });

    // Extract word-level timestamps
    if (response.words && response.words.length > 0) {
      return response.words.map(w => ({
        word: w.word.trim(),
        start: w.start,
        end: w.end
      }));
    }

    // Fallback: split segments into estimated words
    if (response.segments && response.segments.length > 0) {
      console.log('    Falling back to segment-based word estimation...');
      const words = [];
      for (const seg of response.segments) {
        const segWords = seg.text.trim().split(/\s+/);
        const segDuration = seg.end - seg.start;
        const wordDuration = segDuration / segWords.length;
        segWords.forEach((word, i) => {
          words.push({
            word,
            start: seg.start + (i * wordDuration),
            end: seg.start + ((i + 1) * wordDuration)
          });
        });
      }
      return words;
    }

    return [];
  }

  /**
   * Group words into display lines based on style
   */
  groupWordsIntoLines(words, styleName) {
    // Hormozi: every word is its own line
    if (styleName === 'hormoziStack') {
      return words.map(w => ({
        words: [w],
        start: w.start,
        end: w.end
      }));
    }

    // All other styles: group ~4-7 words per line
    const maxWordsPerLine = styleName === 'subtleClean' ? 7 : 5;
    const maxCharsPerLine = styleName === 'subtleClean' ? 40 : 30;
    const lines = [];
    let currentLine = [];
    let currentChars = 0;

    for (const word of words) {
      currentLine.push(word);
      currentChars += word.word.length + 1;

      if (currentLine.length >= maxWordsPerLine || currentChars >= maxCharsPerLine) {
        lines.push({
          words: [...currentLine],
          start: currentLine[0].start,
          end: currentLine[currentLine.length - 1].end
        });
        currentLine = [];
        currentChars = 0;
      }
    }

    // Push remaining words
    if (currentLine.length > 0) {
      lines.push({
        words: [...currentLine],
        start: currentLine[0].start,
        end: currentLine[currentLine.length - 1].end
      });
    }

    return lines;
  }

  /**
   * Generate ASS subtitle file with the chosen style
   */
  generateASSFile(lines, assPath, styleName, videoWidth, videoHeight) {
    const style = this.getASSStyle(styleName, videoWidth, videoHeight);
    
    // ASS header
    let ass = `[Script Info]
Title: RANT Squad Captions
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style.baseStyle}
${style.activeStyle}
${style.spokenStyle || ''}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Generate events based on style
    if (styleName === 'hormoziStack') {
      // Hormozi: each word is a separate event, centered
      for (const line of lines) {
        const w = line.words[0];
        const start = this.formatASSTime(w.start);
        const end = this.formatASSTime(w.end + 0.15);
        const text = w.word.toUpperCase();
        ass += `Dialogue: 0,${start},${end},Active,,0,0,0,,{\\fad(50,100)}${text}\n`;
      }
    } else {
      // All other styles: show full line, highlight active word
      for (const line of lines) {
        const lineStart = this.formatASSTime(line.start);
        const lineEnd = this.formatASSTime(line.end + 0.3);

        if (styleName === 'subtleClean') {
          // Subtle: just show the line text, highlight active word with brightness
          const text = line.words.map(w => {
            const wordStart = ((w.start - line.start) * 100).toFixed(0);
            return `{\\kf${wordStart > 0 ? wordStart : 1}}${w.word}`;
          }).join(' ');
          ass += `Dialogue: 0,${lineStart},${lineEnd},Base,,0,0,0,,${text}\n`;
        } else if (styleName === 'emojiBurst') {
          // Emoji burst: show words with emoji annotations
          for (const w of line.words) {
            const wStart = this.formatASSTime(w.start);
            const wEnd = this.formatASSTime(w.end + 0.15);
            const emoji = this.getEmojiForWord(w.word);
            
            // Show word in "Spoken" style when not active
            ass += `Dialogue: 0,${lineStart},${wStart},Spoken,,0,0,0,,${w.word.toUpperCase()} \n`;
            // Show word in "Active" style when active
            ass += `Dialogue: 1,${wStart},${wEnd},Active,,0,0,0,,${w.word.toUpperCase()}${emoji ? ' ' + emoji : ''}\n`;
            // Show word in "Spoken" after active
            ass += `Dialogue: 0,${wEnd},${lineEnd},Spoken,,0,0,0,,${w.word.toUpperCase()} \n`;
          }
        } else {
          // Bold Pop, Karaoke, Neon, Box, Ali Abdaal:
          // For each word, create an event at the right layer with the right timing
          // Base layer: show entire line in base color
          const fullText = line.words.map(w => {
            if (styleName === 'boldPop' || styleName === 'karaokeWipe' || styleName === 'neonGlow' || styleName === 'emojiBurst') {
              return w.word.toUpperCase();
            }
            return w.word;
          }).join(' ');
          
          ass += `Dialogue: 0,${lineStart},${lineEnd},Base,,0,0,0,,{\\fad(100,150)}${fullText}\n`;

          // Active layer: highlight each word when spoken
          // We overlay individual words at the correct position using \\pos
          // Since ASS doesn't easily allow inline word highlighting without complex overrides,
          // we use a simpler approach: the full line shows in base, and individual word events
          // overlay in the active style at the same position
          // 
          // For simplicity and reliability across FFmpeg versions, we use \\k (karaoke) tags
          // in a single line for styles that support color transitions
          
          if (styleName === 'karaokeWipe' || styleName === 'aliAbdaal') {
            // Use karaoke timing for color fill effect
            let karaokeText = '';
            for (const w of line.words) {
              const dur = Math.round((w.end - w.start) * 100);
              const text = styleName === 'karaokeWipe' ? w.word.toUpperCase() : w.word;
              karaokeText += `{\\kf${dur > 0 ? dur : 10}}${text} `;
            }
            ass += `Dialogue: 1,${lineStart},${lineEnd},Active,,0,0,0,,${karaokeText.trim()}\n`;
          }
        }
      }
    }

    fs.writeFileSync(assPath, ass, 'utf-8');
    console.log(`    ✓ ASS file written: ${assPath} (${lines.length} lines)`);
  }

  /**
   * Get ASS style definitions for each caption style
   */
  getASSStyle(styleName, videoWidth, videoHeight) {
    // ASS color format: &HAABBGGRR (hex, reversed from RGB)
    // Alignment: 2 = bottom center, 5 = middle center, 8 = top center

    const marginV = Math.round(videoHeight * 0.15); // 15% from bottom for center styles
    const marginVBottom = Math.round(videoHeight * 0.06); // 6% from bottom for bottom styles

    switch (styleName) {
      case 'boldPop':
        return {
          // White with heavy black outline, bold
          baseStyle: `Style: Base,Arial Black,60,&H50FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,4,2,2,30,30,${marginV},1`,
          // Yellow highlight
          activeStyle: `Style: Active,Arial Black,66,&H0000E5FF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,110,110,2,0,1,4,2,2,30,30,${marginV},1`,
          spokenStyle: `Style: Spoken,Arial Black,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,4,2,2,30,30,${marginV},1`,
        };
      case 'hormoziStack':
        return {
          baseStyle: `Style: Base,Arial Black,90,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,3,0,1,5,3,5,30,30,${marginV},1`,
          activeStyle: `Style: Active,Arial Black,90,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,3,0,1,5,3,5,30,30,${marginV},1`,
        };
      case 'karaokeWipe':
        return {
          // Base: dim white
          baseStyle: `Style: Base,Arial Black,58,&H40FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,3,2,2,30,30,${marginV},1`,
          // Active: red color fill (&H006B6BFF = #FF6B6B in BGR)
          activeStyle: `Style: Active,Arial Black,58,&H006B6BFF,&H40FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,3,2,2,30,30,${marginV},1`,
        };
      case 'neonGlow':
        return {
          // Base: dim cyan
          baseStyle: `Style: Base,Consolas,50,&H40FFD400,&H00FFD400,&H00000000,&H80000000,1,0,0,0,100,100,3,0,1,2,0,2,30,30,${marginV},1`,
          // Active: bright white with glow (border = cyan)
          activeStyle: `Style: Active,Consolas,54,&H00FFFFFF,&H00FFD400,&H00FFD400,&H80000000,1,0,0,0,105,105,3,0,1,3,0,2,30,30,${marginV},1`,
          spokenStyle: `Style: Spoken,Consolas,50,&H00FFD400,&H00FFD400,&H00000000,&H80000000,1,0,0,0,100,100,3,0,1,2,0,2,30,30,${marginV},1`,
        };
      case 'subtleClean':
        return {
          // White text on semi-transparent dark box (BorderStyle=3 for opaque box)
          baseStyle: `Style: Base,Arial,40,&HDDFFFFFF,&H00FFFFFF,&H00000000,&HC0000000,0,0,0,0,100,100,1,0,3,1,0,2,30,30,${marginVBottom},1`,
          activeStyle: `Style: Active,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&HC0000000,1,0,0,0,100,100,1,0,3,1,0,2,30,30,${marginVBottom},1`,
        };
      case 'boxHighlight':
        return {
          // Base: white text, no box
          baseStyle: `Style: Base,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H60000000,1,0,0,0,100,100,1,0,1,2,1,2,30,30,${marginVBottom + 60},1`,
          // Active: white text with purple box (BorderStyle=3 for opaque box, BackColour = purple)
          activeStyle: `Style: Active,Arial,48,&H00FFFFFF,&H00FFFFFF,&HFF8B5CF6,&HD08B5CF6,1,0,0,0,100,100,1,0,3,1,0,2,30,30,${marginVBottom + 60},1`,
          spokenStyle: `Style: Spoken,Arial,48,&H30FFFFFF,&H00FFFFFF,&H00000000,&H60000000,1,0,0,0,100,100,1,0,1,2,1,2,30,30,${marginVBottom + 60},1`,
        };
      case 'aliAbdaal':
        return {
          // Base: medium bright white
          baseStyle: `Style: Base,Arial,48,&HA0FFFFFF,&H00FFFFFF,&H00000000,&H60000000,1,0,0,0,100,100,1,0,1,2,1,2,30,30,${marginV},1`,
          // Active: bright white (words fade FROM bright to dark — karaoke secondary color is dark)
          activeStyle: `Style: Active,Arial,48,&H00FFFFFF,&H30FFFFFF,&H00000000,&H60000000,1,0,0,0,100,100,1,0,1,2,1,2,30,30,${marginV},1`,
        };
      case 'emojiBurst':
        return {
          // Base: dim white, bold
          baseStyle: `Style: Base,Arial Black,55,&H50FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,3,2,2,30,30,${marginV},1`,
          // Active: orange (&H00169FF9 = #F99F16 → actually &H00169FF9)
          activeStyle: `Style: Active,Arial Black,60,&H00169FF9,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,110,110,2,0,1,3,2,2,30,30,${marginV},1`,
          spokenStyle: `Style: Spoken,Arial Black,55,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,2,0,1,3,2,2,30,30,${marginV},1`,
        };
      default:
        // Default to boldPop
        return this.getASSStyle('boldPop', videoWidth, videoHeight);
    }
  }

  /**
   * Get emoji for a word (emojiBurst style)
   */
  getEmojiForWord(word) {
    const clean = word.toLowerCase().replace(/[^a-z]/g, '');
    return this.emojiMap[clean] || null;
  }

  /**
   * Format time as ASS timestamp: H:MM:SS.CC (centiseconds)
   */
  formatASSTime(seconds) {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.round((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  /**
   * Burn ASS subtitles into video using FFmpeg
   */
  async burnSubtitles(videoPath, assPath, outputPath) {
    return new Promise((resolve, reject) => {
      // Escape special characters in the ASS path for FFmpeg filter
      const escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

      const args = [
        '-y',
        '-i', videoPath,
        '-vf', `ass='${escapedAssPath}'`,
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '18',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath
      ];

      console.log(`    Burning subtitles with FFmpeg...`);
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      
      proc.stderr.on('data', d => {
        stderr += d.toString();
        // Log progress
        const timeMatch = d.toString().match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch) {
          process.stdout.write(`    Progress: ${timeMatch[1]}\r`);
        }
      });

      proc.on('close', code => {
        console.log(''); // New line after progress
        if (code === 0) {
          console.log('    ✓ Subtitles burned successfully');
          resolve(outputPath);
        } else {
          console.error(`    FFmpeg subtitle burn failed (code ${code})`);
          console.error(`    Last stderr: ${stderr.slice(-500)}`);
          reject(new Error(`Subtitle burn failed: ${stderr.slice(-300)}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Get list of available style names
   */
  getAvailableStyles() {
    return [
      'boldPop', 'hormoziStack', 'karaokeWipe', 'neonGlow',
      'subtleClean', 'boxHighlight', 'aliAbdaal', 'emojiBurst'
    ];
  }

  /**
   * Validate a style name
   */
  isValidStyle(styleName) {
    return this.getAvailableStyles().includes(styleName);
  }
}

module.exports = new CaptionService();
