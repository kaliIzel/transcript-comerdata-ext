async function readTrack(mode, onSegment) {
  const cdnOrigin = "https://vz-cdedf6d1-d36.b-cdn.net";
  const resources = performance.getEntriesByType("resource")
    .map(entry => new URL(entry.name))
    .filter(url => url.origin === cdnOrigin);
  const video = resources.findLast(url => url.pathname.endsWith("/video.m3u8"));
  if (!video) {
    throw new Error("Reproduce unos segundos, pausa la lección y vuelve a pulsar Transcribir.");
  }

  const deadline = AbortSignal.timeout(180_000);
  const fetchResource = async (url, label) => {
    if (url.origin !== cdnOrigin) {
      throw new Error("El manifiesto hace referencia a otro servidor.");
    }
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(15_000)]);
    let response;
    try {
      response = await fetch(url, { redirect: "error", signal });
    } catch {
      throw new Error(`Brave no pudo leer ${label} desde el reproductor.`);
    }
    if (!response.ok) {
      throw new Error(`El servidor respondió HTTP ${response.status} para ${label}.`);
    }
    return response;
  };

  const readPlaylist = async (url, label) => {
    const response = await fetchResource(url, label);
    let body;
    try {
      body = await response.text();
    } catch {
      throw new Error(`Se interrumpió la lectura de ${label}.`);
    }
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") {
      throw new Error("La respuesta no contiene un manifiesto HLS.");
    }
    return lines;
  };

  try {
    let playlist = video;
    if (mode === "audio") {
      const master = resources.findLast(url => url.pathname.endsWith("/playlist.m3u8"));
      if (!master) return null;
      const variants = await readPlaylist(master, "el manifiesto principal");
      const audioTracks = variants.filter(line =>
        line.startsWith("#EXT-X-MEDIA:") && /[:,]TYPE=AUDIO(?:,|$)/.test(line)
        && /[:,]URI="[^"]+"/.test(line)
      );
      const track = audioTracks.find(line => /[:,]DEFAULT=YES(?:,|$)/.test(line))
        ?? audioTracks[0];
      if (!track) return null;
      const [, uri] = track.match(/[:,]URI="([^"]+)"/);
      playlist = new URL(uri, master);
    }

    const lines = await readPlaylist(playlist, "el manifiesto de segmentos");
    const segments = lines.filter(line => !line.startsWith("#"));
    const durations = lines.filter(line => line.startsWith("#EXTINF:"))
      .map(line => Number(line.slice("#EXTINF:".length).split(",")[0]));
    if (!lines.includes("#EXT-X-ENDLIST") || !segments.length
        || durations.length !== segments.length
        || durations.some(seconds => !Number.isFinite(seconds) || seconds <= 0)) {
      throw new Error("No se encontró una lista completa de segmentos bajo demanda.");
    }
    if (lines.some(line => /^#EXT-X-(?:KEY:(?!METHOD=NONE(?:,|$))|BYTERANGE:|MAP:|GAP$)/.test(line))) {
      throw new Error("La lista requiere cifrado o un formato de segmentos que este prototipo no admite.");
    }
    if (segments.length > 600) {
      throw new Error("La lección supera el límite de 600 segmentos.");
    }

    const seconds = Math.round(durations.reduce((total, duration) => total + duration, 0) * 1e6) / 1e6;
    if (seconds > 15 * 60) {
      throw new Error("Esta versión admite lecciones de hasta 15 minutos.");
    }
    for (let index = 0; index < segments.length; index++) {
      const label = `el segmento ${index + 1} de ${segments.length}`;
      const response = await fetchResource(new URL(segments[index], playlist), label);
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`No se recibió contenido para ${label}.`);
      let bytes = 0;
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8_000_000) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      } catch {
        throw new Error(`Se interrumpió la lectura de ${label}.`);
      }
      if (!bytes) throw new Error(`El servidor devolvió vacío ${label}.`);
      if (bytes > 8_000_000) throw new Error(`El tamaño de ${label} supera el límite por segmento.`);
      const sample = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        sample.set(chunk, offset);
        offset += chunk.byteLength;
      }
      onSegment(sample, index + 1, segments.length);
    }

    return { seconds };
  } catch (error) {
    // Errors produced by URL parsing may include the temporary CDN link.
    if (error instanceof TypeError) {
      throw new Error("No se pudo interpretar el manifiesto o el formato del audio.");
    }
    throw error;
  }
}
