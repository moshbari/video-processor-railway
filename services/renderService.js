/**
 * Add reactions with PAUSE-AND-REACT style - SIMPLIFIED VERSION
 */
async addReactionsPauseAndReact(videoPath, reactions, workDir) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(workDir, 'with_reactions.mp4');

    // Sort reactions by timestamp
    const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

    // For now, use simple text overlay instead of complex pause-and-react
    // This will work while we debug the complex version
    const textOverlays = sortedReactions.map((reaction) => {
      const text = reaction.text.replace(/[:']/g, ' ').substring(0, 100); // Simplify text
      const start = reaction.timestamp;
      const end = start + (reaction.duration || 3);
      
      return `drawtext=text='${text}':fontsize=32:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5:x=(w-text_w)/2:y=h-100:enable='between(t,${start},${end})'`;
    }).join(',');

    console.log('Using simplified text overlay');

    ffmpeg(videoPath)
      .videoFilters(textOverlays)
      .outputOptions([
        '-c:v libx264',
        '-preset medium',
        '-crf 23',
        '-c:a copy',
        '-movflags +faststart'
      ])
      .on('start', cmd => console.log('FFmpeg command:', cmd))
      .on('progress', progress => {
        if (progress.percent) {
          console.log(`Rendering progress: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        console.log('Simple overlay rendering complete!');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        reject(err);
      })
      .save(outputPath);
  });
}