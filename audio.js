function createAudioExtractor() {
  const transmuxer = new muxjs.Transmuxer({ remux: false });
  const parts = [];
  transmuxer.on("data", segment => {
    if (segment.type !== "audio") return;
    if (!parts.length) parts.push(segment.initSegment);
    parts.push(segment.data);
  });

  return {
    append(sample) {
      transmuxer.push(sample);
      transmuxer.flush();
    },
    finish() {
      return parts.length ? new Blob(parts, { type: "audio/mp4" }) : null;
    },
    dispose() {
      transmuxer.dispose();
    }
  };
}
