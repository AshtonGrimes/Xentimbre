// This file is part of Xentimbre, which is released under the GNU General Public License v3 or later.
// See the COPYING or LICENSE file in the root directory of this project or visit <http://www.gnu.org/licenses/gpl-3.0.html>.

const Global = {
  ref: 262, divs: 12, equave: 2, dissSens: 1 + Math.pow(2, -43 / 4), volume: 30,
  att: 0.2, dec: 0.2, sus: 0.8, rel: 1,
  harmonics: new Array(32).fill().map(() => new Harmonic()),
  blockPlaying: true, playing: new Array(32).fill({ oscs: new Array(0), gs: new Array(0) }), // NOTE: blockPlaying initialized to true, set false once page loads
  audioContext: undefined,
  graphState: {
    select: "edn",
    dissScale: 0,
    otherScale: 16
  }
}

const Timer = {
  status: undefined,
  blockPlaying: undefined,
  resize: undefined,
  diss: undefined,
  vol: undefined  
}

Global.harmonics[0] = new Harmonic(1, 1, 0);
const playKeys = "zxcvbnm,.asdfghjklqwertyuio123456789";
const errColor = "#C55", dwgColor = "#02F8D4", rulerMarkColor = ["#CCC", "#222", "#FFF"];

const obs = new PerformanceObserver((tasks) => {
  Global.blockPlaying = true;
  if (Timer.blockPlaying) clearTimeout(Timer.blockPlaying);
  Timer.blockPlaying = setTimeout(() => Global.blockPlaying = false, 500);
  if (Global.audioContext) Global.audioContext.audio.close().then(() => Global.audioContext = initAudio());
  log("Performance", `${tasks.getEntries()[0].duration}ms task detected. Blocking sound to prevent distortion.`);
});
const lcpObs = new PerformanceObserver(() => {
  obs.observe({ type: "longtask", buffered: false });
  Global.blockPlaying = false;
  log("Performance", "Page loading complete. Starting performance monitoring. This will block new sounds on the keyboard player for 500ms if a \"long task\" (longer than 50ms) is found.");
  lcpObs.disconnect();
});
lcpObs.observe({ type: "largest-contentful-paint", buffered: true });

function initAudio() {
  const audio = new window.AudioContext();
  const delay = audio.createDelay();
  delay.delayTime.value = 0.1;
  const cmp = audio.createDynamicsCompressor(); // To prevent sounds too loud
  cmp.threshold.value = decibel(Global.volume); // Threshold, knee, and ratio are in db, while attack/release are in seconds
  cmp.knee.value = 30; // Gentle compression
  cmp.ratio.value = 5; // For every 5 db over the threshold, 1 db increase
  cmp.attack.value = 0.2; // NOTE: attack > 0 makes painful oscillations depending on the configuration
  cmp.release.value = 0.2; 
  return { audio: audio, delay: delay, cmp: cmp };
}

function restartAudio() {
  Global.playing.forEach(k => { if (!invalid(k)) k.oscs.forEach(osc => { if (!invalid(osc)) osc.stop(0) }) });
  Global.playing = new Array(32).fill({ oscs: new Array(0), gs: new Array(0) });
  Global.audioContext.audio.close().then(() => Global.audioContext = initAudio());
}

document.getElementById("explen").addEventListener("input", e => { // "Export sample" duration input, accepts floats > 0 but not fractions
  if (e.target.value == "") { // Empty duration won't allow export, but to "clear" the input it should be transparent
    e.target.style.backgroundColor = "transparent"; 
  } else if (e.target.value < 0 || invalid(e.target.value)) {
    e.target.style.backgroundColor = errColor;
  } else { 
    e.target.style.backgroundColor = "transparent"; 
  }
});

const importUpload = document.getElementById("import"); // Hidden input clicked when "Import sample" detects a click

function sampleImport() { importUpload.click() } // I opted for this instead of the default upload input, since I do not like how it looks

function audioFile(buffer) {
  const a = new AudioContext();
  return new Promise((resolve, reject) => {
    a.decodeAudioData(buffer)
      .then(data => resolve({ 
        data: Array.from(data.getChannelData(0)), 
        sampleRate: data.sampleRate, 
        duration: data.duration 
      }))
      .catch(e => reject(e));
  });
}

importUpload.addEventListener("change", () => {
  const status = document.getElementById("importStatus");
  clearTimeout(Timer.status);
  Timer.status = setTimeout(() => status.innerText = "", 7000); // Clears error messages if any are set

  let file = importUpload.files[0]; // Can contain multiple files; needs to be reset every time
  importUpload.value = "";
  if (!file) return;
  log("File Import", `${file.name} uploaded.`);

  const extension = file.name.split(".").pop();
  const validExts = ["wav", "mp3", "mp4", "m4a", "ogg", "mov", "webm", "aac", "flac", "wma"];
  if (!validExts.includes(extension)) {
    status.innerText = "Audio files only";
    log("File Import", `Unsupported extension "${extension}", exiting.`);
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    audioFile(e.target.result).then(audio => {
      log("File Import", `File header is valid. Isolated audio data.`);
      console.log(audio);
      log("File Import", `Processing ${audio.data.length} audio samples into harmonics using the Chirp Z-transform.`);
      console.time("CZT");
      const ft = Fourier.czt(audio.data, NYQUIST);
      console.timeEnd("CZT");
      log("File Import", `Processing complete. Average amplitude of all frequency bins is ${ft.avg} bits.`);
      console.log(ft.data);
      let prevCont = Number.POSITIVE_INFINITY, currCont = Number.POSITIVE_INFINITY, nextCont, usefulCont = new Array();
      for (let k = 0; k < ft.data.length && usefulCont.length < 32; k++) { 
        nextCont = ft.data[k].abs();
        if (nextCont < currCont // The frequency must be a local maximum and have an above average magnitude
          && currCont > prevCont
          && currCont > ft.avg
        ) usefulCont.push(k - 1); // The frequency (index) at currCont is pushed if it passes the checks
        prevCont = currCont;
        currCont = nextCont;
      }
  
      log("File Import", "Isolated most prominent frequencies from FFT frequency content.");
      console.log(usefulCont);
      if (usefulCont[0]) {
        usefulCont = usefulCont.map(x => ({ freq: x, data: ft.data[x] }));
        let k, avg, amplMax = 0;
        for (let i = 0; i < usefulCont.length; i++) { 
          k = usefulCont[i].freq;  // Taking the most prevalent frequency bin and adjusting the exact frequency data to account for in-between frequencies/spectral leakage
          // Added null checks in case k = 0 or k = ft.data.length
          avg = ((ft.data[k - 1].abs() ?? 0) + ft.data[k].abs() + (ft.data[k + 1].abs() ?? 0)) / 3; 
          usefulCont[i].freq -= (ft.data[k - 1].abs() ?? 0) / avg; 
          usefulCont[i].freq += (ft.data[k + 1].abs() ?? 0) / avg;
          
          avg = ((ft.data[k - 1].r ?? 0) + ft.data[k].r + (ft.data[k + 1].r ?? 0)) / 3;
          usefulCont[i].data.r -= (ft.data[k - 1].r ?? 0) / avg;
          usefulCont[i].data.r += (ft.data[k + 1].r ?? 0) / avg;
    
          avg = ((ft.data[k - 1].i ?? 0) + ft.data[k].i + (ft.data[k + 1].i ?? 0)) / 3;
          usefulCont[i].data.i -= (ft.data[k - 1].i ?? 0) / avg;
          usefulCont[i].data.i += (ft.data[k + 1].i ?? 0) / avg;
          // Harmonics adjusted according to the highest amplitude of any harmonic processed
          if (amplMax < usefulCont[i].data.abs()) amplMax = usefulCont[i].data.abs();
        }
    
        log("File Import", "Frequency data regrouped with amplitude and phase. Data adjusted to nearby frequency bins.");
        console.log(usefulCont);
    
        hClear(); // Reset all harmonics
        // First notable frequency is automatically the fundamental, for better or worse
        Global.harmonics[0].a = Number((usefulCont[0].data.abs() / amplMax).toFixed(4)); 
        const fundFreq = usefulCont[0].freq, fundPhaseAdj = usefulCont[0].data.phase();
        log("File Import", `${usefulCont.length} useful harmonic${usefulCont.length != 1 ? "s" : ""} found. Fundamental frequency is ${fundFreq} with an absolute phase of ${fundPhaseAdj}.`)
        document.getElementById("h-ampl-1").value = Global.harmonics[0].a;
        for (let i = 2; i <= Math.min(32, usefulCont.length); i++) {
          Global.harmonics[i - 1] = new Harmonic(
            Number((usefulCont[i - 1].freq / fundFreq).toFixed(4)), 
            Number((usefulCont[i - 1].data.abs() / amplMax).toFixed(4)), 
            Number(usefulCont[i - 1].data.phase(fundPhaseAdj).toFixed(4))
          );
          document.getElementById(`h-ratio-${i}`).value = Global.harmonics[i - 1].r;
          document.getElementById(`h-ampl-${i}`).value = Global.harmonics[i - 1].a;
          document.getElementById(`h-phase-${i}`).value = Global.harmonics[i - 1].p;
        }
        redrawGraphs();
      } else log("File Import", "No useful harmonics found!");
      log("File Import", "Import complete, exiting.");
      if (Global.audioContext) Global.audioContext.audio.close().then(() => Global.audioContext = initAudio());
    }).catch(e => { 
      log("File Import", "========== ERROR ==========");
      console.error(e);
      log("File Import", "===========================");
      log("File Import", "See above error, exiting.");
      status.innerText = "Audio decoding error (check console)";
    });  
  }
  reader.readAsArrayBuffer(file);
});

function sampleExport() { // Called when "Export sample" is clicked
  const exp = document.getElementById("explen");
  let len = exp.value;
  if (invalid(len) || len < 0) { // One last check for invalid sample duration
    exp.style.backgroundColor = errColor;
    return;
  } else {
    log("File Export", `Processing ${len}s sample export.`);
    exp.style.backgroundColor = "transparent";
    len = Math.round(len * 44100) * 2; // Length in seconds is converted to length in bytes, multiplied after to prevent rounding errors
  }

  let header = new Int8Array([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0, 0, 0, 0, // File size (samples * byte rate + 36 for headers)
    0x57, 0x41, 0x56, 0x45, // "WAVE"
    0x66, 0x6D, 0x74, 0x20, // "fmt "
    16, 0, 0, 0, // Subchunk 1 size
    1, 0, 1, 0, // PCM followed by 1 for mono
    0x44, 0xAC, 0, 0, // 44100 sample frequency
    0x88, 0x58, 0x01, 0, // 88200 byte rate
    2, 0, 16, 0, // Channels * bytes per sample followed by bits per sample
    0x64, 0x61, 0x74, 0x61, // "data"
    0, 0, 0, 0 // Data section length (samples * bytes per sample)
  ]);

  len += 36; // Samples + header length, in bytes
  header[4] = len & 0xFF; // Converting len to little endian format
  header[5] = (len >> 8) & 0xFF;
  header[6] = (len >> 16) & 0xFF;
  header[7] = (len >> 24) & 0xFF;
  len -= 36; // len now represents number of bytes, converting to little endian as before  
  header[40] = len & 0xFF; 
  header[41] = (len >> 8) & 0xFF;
  header[42] = (len >> 16) & 0xFF;
  header[43] = (len >> 24) & 0xFF;
  log("File Export", `Header specifies a file size of ${len + 44} bytes with ${len / 2} samples. Adjusted duration is ${len / 88200}s.`);
  console.log(header);
  len /= 2; // len now represents number of samples
  
  const active = Global.harmonics.filter(h => !invalid(h.r) && !invalid(h.a))
    .map(h => new Harmonic(h.r, h.a, zinvalid(h.p) ? 0 : h.p)); 
  const total = active.reduce((acc, h) => acc + h.a, 0); // Otherwise enough high-amplitude harmonics would cause clipping
  console.log(active)
  console.log(total)
  
  let data = new Int16Array(len); 
  for (let i = 0; i < len; i++) { // Audio data written as a sum of the sine waves at 75% amplitude
    data[i] = active.reduce((acc, h) => acc + ( 
      /* 24575 is 75% of 16 bits, * amplitude, * sin(
        2pi * ((reference / samples to convert to seconds) - phase shift)
      ), / total amplitude correction */
      Math.round(24575 * h.a * sin2pi((Global.ref * h.r * i / 44100) - h.p) / total)
    ), 0);
  }
  log("File Export", `${len} samples generated.`);
  console.log(data);

  const file = new Blob([header.buffer, data.buffer], { type: "audio/wav" }); // After writing all the data, the file is created with the header + data arrays
  const href = window.URL.createObjectURL(file); // Download link must be a named const so it can be removed later
  const d = document.createElement("a"); // Invisible link which is added, clicked, and removed so the user receives a download prompt for the file
  d.style.display = "none";
  d.href = href;
  d.download = "Timbre.wav";
  document.body.appendChild(d);
  d.click();
  window.URL.revokeObjectURL(href);
  document.body.removeChild(d); 
  log("File Export", "Export ready for download, exiting.");
}

window.addEventListener("resize", () => { // Resizes graph details to match page size
  clearTimeout(Timer.resize);
  Timer.resize = setTimeout(() => { redrawGraphs(); redrawAdsr(); }, 500);
});

function handleSelect(sel) { // Called by "Optimal edN"/"Waveform" inputs
  Global.graphState.select = sel;
  redrawGraphs();
}

document.getElementById("diss").addEventListener("click", (e) => {
  const x = e.clientX - document.getElementById("diss").getBoundingClientRect().left;
  if (x < diss.clientWidth / 2) Global.graphState.dissScale--; // Click left reduces range, click right increases range
  else Global.graphState.dissScale++;
  redrawGraphs();
});

document.getElementById("other").addEventListener("click", (e) => {
  const x = e.clientX - document.getElementById("other").getBoundingClientRect().left;
  if (x < diss.clientWidth / 2) Global.graphState.otherScale /= 2; // Click left reduces range, click right increases range
  else Global.graphState.otherScale *= 2;
  redrawGraphs();
});

function redrawGraphs() { // Dissonance curve and waveform drawings
  const diss = document.getElementById("diss");

  diss.width = diss.clientWidth * 4; // Adds needed resolution to the HTML canvas, which normally looks quite grainy
  diss.height = diss.clientHeight * 4;
  let c = diss.getContext("2d");
  c.clearRect(0, 0, diss.width, diss.height);
  const active = Global.harmonics.filter(h => (!invalid(h.r) && !invalid(h.a))) // Valid harmonics only
    .map(h => new Harmonic(h.r, h.a, zinvalid(h.p) ? 0 : h.p));
  let intAdj = 0, activeAdj = [];
  let y = new Array(), yMax = 0;
  let yNext, yCurrent = 0, yPrev = 0, marks = new Array(); 
  const eqAdj = 1 + Math.pow(Global.equave, Global.graphState.dissScale / 8);

  for (let i = 1; i <= diss.width; i++) {
    intAdj = ((i / diss.width) * (eqAdj - 1)) + 1; // Range from 1:1 to adjusted-equave:1
    activeAdj = active.map(h => new Harmonic(h.r * intAdj, h.a)); // New harmonic object with x adjustment and no phase information
    yNext = active.reduce((acc, h) => acc + activeAdj.reduce((acc, hadj) => acc + (
      Math.min(h.a, hadj.a) * disscalc(Math.max(h.r, hadj.r) / Math.min(h.r, hadj.r)) // Sum  of the dissonance of every combination
    ), 0), 0);
    if (yMax < yNext) yMax = yNext;
    y.push(yNext);
    if (yNext > yCurrent // yCurrent must represent a local minimum
      && yCurrent < yPrev
      && yNext / yCurrent > Global.dissSens
    ) marks.push({ 
      ratio: ((i - 1) / diss.width) * (eqAdj - 1) + 1, // The interval yCurrent corresponds to
      x: i - 1 // The x coordinate of yCurrent
    }); 
    yPrev = yCurrent;
    yCurrent = yNext;
  } 
  // Number of powers of the equave in the graph; for example, if the graph was from 1:1 to 5:1, and the equave was 2, there would be 2 equave marks: at 2:1 and 4:1
  const equaveMarksLen = Math.floor(Math.log(eqAdj) / Math.log(Global.equave));
  if (equaveMarksLen) {
    c.beginPath();
    c.strokeStyle = rulerMarkColor[2];
    c.lineWidth = 5;
    for (let i = 1; i <= equaveMarksLen; i++) {
      // Using interval = ((x / diss.width) * (eqAdj - 1)) + 1, solving for x
      const x = Math.round(diss.width * (Math.pow(Global.equave, i) - 1) / (eqAdj - 1));
      c.moveTo(x, 0);
      c.lineTo(x, diss.height);
    }
    c.stroke();
  }
  c.beginPath()
  c.lineWidth = diss.height / 40;
  c.strokeStyle = dwgColor;
  c.moveTo(0, diss.height);
  for (let i = 1; i < diss.width; i++) c.lineTo(i, diss.height * (1 - (y[i] / yMax)));
  c.stroke();
  c.beginPath();
  c.lineWidth = diss.height / 80;
  c.strokeStyle = "#3FFD04";
  c.font = `${Math.round(50 * Math.sqrt(diss.width / diss.height))}px sans`;
  c.fillStyle = rulerMarkColor[1];
  c.textAlign = "left";
  c.textBaseline = "middle";
  y = diss.height / 8;
  let posIndex = 1;
  for (let i = 0; i < marks.length; i++) { // Makes a vertical line for each mark
    c.moveTo(marks[i].x, diss.height); 
    c.lineTo(marks[i].x, 0);
  }
  c.stroke(); // Draws the lines BEFORE adding the text, so the text is over the lines
  for (let i = 0; i < marks.length; i++) {
    c.fillText(`${Number(marks[i].ratio.toFixed(3))}`, marks[i].x, y * posIndex);
    posIndex %= 4; 
    posIndex++; // Adding after the modulus so the positions will be 1 2 3 4 not 0 1 2 3
  }
    
  const draw = document.getElementById("other"); // Same procedure as for the dissonance curve, but this time for the waveform
  draw.width = draw.clientWidth * 4;
  draw.height = draw.clientHeight * 4;
  c = draw.getContext("2d"); 
  c.beginPath();
  c.clearRect(0, 0, draw.width, draw.height);
  
  const label = document.getElementById("othertext");
  if (Global.graphState.select === "wave") { 
    label.innerText = "Sound Wave";
    c.lineWidth = draw.height / 40;
    c.strokeStyle = dwgColor;
    // Scaling variable for the largest possible constructive interference of the sine waves
    let amplCenter = Global.harmonics.reduce((acc, h) => acc + ((!invalid(h.r) && !invalid(h.a)) ? h.a : 0), 0);
    for (let i = 0; i < draw.width; i++) { // Cannot use IFFT since it would only be accurate to evaluate at the number of active harmonics 
      y = active.reduce(
        (acc, h) => (acc + (
          h.a * sin2pi(
            ((Math.pow(Global.graphState.otherScale, 1 / 4) * h.r * i) / draw.width) - 
            (zinvalid(h.p) ? 0 : h.p)
          )
        )
      ), 0) / amplCenter;
      y = draw.height * (1 - ((y + 1) / 2)); // Keeps y = 0 vertically centered
      if (i) c.lineTo(i, y);
      else c.moveTo(i, y); // i == 0, starting position
    }
  } else /*if (graphState.select === "edn")*/ {
    label.innerText = `Ideal ed${Global.equave}s`;
    c.beginPath();
    c.strokeStyle = rulerMarkColor[0];
    c.lineWidth = 5;
    const adjFactor = 10 * Math.pow(Global.graphState.otherScale, 1 / 4);
    yPrev = -1, yCurrent = 0;
    for (let i = 1; i < draw.width; i++) {
      intAdj = adjFactor * i / draw.width;
      yNext = Math.abs(intAdj - Math.round(intAdj));
      if (yNext >= yCurrent && yCurrent <= yPrev) {
        c.moveTo(i - 1, draw.height);
        if (!(Math.round(intAdj) % 8)) posIndex = 4;
        else if (!(Math.round(intAdj) % 4)) posIndex = 3;
        else if (!(Math.round(intAdj) % 2)) posIndex = 2;
        else posIndex = 1;
        c.lineTo(i - 1, draw.height * (1 - (posIndex / 16)));
      }
      yPrev = yCurrent;
      yCurrent = yNext;
    }
    c.stroke();

    c.beginPath();
    c.lineWidth = draw.height / 40;
    c.strokeStyle = dwgColor;
    c.moveTo(0, 0);
    if (!marks.length) { // No target intervals
      c.lineTo(draw.width, 0);
    } else {
      const search = marks.map(m => ({ ratio: m.ratio, weight: 1 / disscalc(m.ratio) }));
      const weightSum = search.reduce((acc, s) => acc + s.weight, 0);
      y = new Array(draw.width);
      yMax = 0;
      for (let i = 1; i < draw.width; i++) { 
        intAdj = adjFactor * i / draw.width;
        y[i - 1] = -Math.log(search.reduce(
          (acc, s) => acc + (
            s.weight * Math.pow((
              (intAdj * Math.log(s.ratio) / Math.log(Global.equave)) -
              Math.round(intAdj * Math.log(s.ratio) / Math.log(Global.equave))
            ), 2)
          ), 0) / (search.length * weightSum)
        );
        if (yMax < y[i - 1]) yMax = y[i - 1];
      } 
      y = y.map(val => val / yMax);
      for (let i = 0; i < draw.width; i++) c.lineTo(i + 1, draw.height * (1 - y[i]));
    }
    c.stroke();

 }
  c.stroke();
}

document.getElementById("divs").addEventListener("input", d => { // Number of divisions of the equave, accepts only whole numbers
  let val = d.target.value;
  if (invalid(val) || val != Math.floor(val)) {
    d.target.style.backgroundColor = errColor;
  } else {
    Global.divs = val;
    d.target.style.backgroundColor = "transparent";
    redrawGraphs();
  }
});

document.getElementById("interval").addEventListener("input", i => { // Equave, accepts floats and fractions > 1
  let val = i.target.value, int; 
  if (val.includes("/")) {
    let nums = val.trim().split("/"); // String .split, NOT array .split
    if (invalid(nums[0]) || invalid(nums[1])) {
      i.target.style.backgroundColor = errColor;
      return;
    } else int = (nums[0] / nums[1]);
  } else if (!invalid(val)) { 
    int = parseFloat(val.trim());
  } else {
    i.target.style.backgroundColor = errColor;
    return;
  }

  if (int <= 1) {
    i.target.style.backgroundColor = errColor;
  } else {
    Global.equave = int;
    i.target.style.backgroundColor = "transparent";
    redrawGraphs();
  }
});

document.getElementById("ref").addEventListener("input", r => { // Reference frequency (mapped to "A" key), accepts a float but not a fraction
  let val = r.target.value.trim();
  if (invalid(val)) {
    r.target.style.backgroundColor = errColor;
  } else {
    Global.ref = parseFloat(val);
    r.target.style.backgroundColor = "transparent";
  }
}); 

document.getElementById("dissSens").addEventListener("input", d => {
  clearTimeout(Timer.diss);
  const val = Number(d.target.value), max = document.getElementById("dissSens").max;
  if (val == max) Global.dissSens = 0;
  else if (val) Global.dissSens = 1 + Math.pow(2, (-val / 8) - 10);
  else /*0*/ Global.dissSens = Number.POSITIVE_INFINITY;
  Timer.diss = setTimeout(() => redrawGraphs(), 100); 
});

document.getElementById("vol").addEventListener("input", v => {
  clearTimeout(Timer.vol);
  Timer.vol = setTimeout(() => {
    Global.volume = parseInt(v.target.value);
    document.getElementById("voltext").innerText = v.target.value + "%";
    if (Global.audioContext) Global.audioContext.audio.close().then(() => Global.audioContext = initAudio());
  }, 100);
});

document.getElementById("preset").addEventListener("change", p => {
  if (p.target.value == "none") return; 
  // If any other option is selected, the dissonance curve + wave are redrawn and any red input backgrounds are made transparent because there are no errors in presets
  Global.harmonics[0][1] = 1;
  document.getElementById("h-ampl-1").value = 1;
  switch (p.target.value) {
    case "triangle":
      for (let i = 2; i <= 32; i++) {
        Global.harmonics[i - 1] = new Harmonic((2 * i) - 1, 1 / Math.pow((2 * i) - 1, 2), undefined);
        document.getElementById(`h-ratio-${i}`).value = (2 * i) - 1; // Series: 1, 3, 5, 7...
        document.getElementById(`h-ampl-${i}`).value = Number(Global.harmonics[i - 1].a.toFixed(4)); // Wrapping the decimal truncation in a Number() gets rid of trailing zeros, series: 1, 1/9, 1/25, 1/49... 
        if (i % 2) {
          document.getElementById(`h-phase-${i}`).value = ""; 
        } else {
          Global.harmonics[i - 1].p = 0.5; // Every other harmonic is offset by 0.5          
          document.getElementById(`h-phase-${i}`).value = 0.5; 
        }
      }
      break;
    case "sawtooth":
      for (let i = 2; i <= 32; i++) {
        Global.harmonics[i - 1] = new Harmonic(i, 1 / i, undefined);
        document.getElementById(`h-ratio-${i}`).value = i;
        document.getElementById(`h-ampl-${i}`).value = Number(Global.harmonics[i - 1].a.toFixed(4));
        document.getElementById(`h-phase-${i}`).value = "";
      }
      break;
    case "square":
      for (let i = 2; i <= 32; i++) {
        Global.harmonics[i - 1] = new Harmonic((2 * i) - 1, 1 / ((2 * i) - 1), undefined);
        document.getElementById(`h-ratio-${i}`).value = (2 * i) - 1;
        document.getElementById(`h-ampl-${i}`).value = Number(Global.harmonics[i - 1].a.toFixed(4));
        document.getElementById(`h-phase-${i}`).value = "";
      }
      break;
  }

  document.getElementById("h-ampl-1").style.backgroundColor = "transparent";
  for (let i = 2; i <= 32; i++) {
    document.getElementById(`h-ratio-${i}`).style.backgroundColor = "transparent";
    document.getElementById(`h-ampl-${i}`).style.backgroundColor = "transparent";
    document.getElementById(`h-phase-${i}`).style.backgroundColor = "transparent";    
  }

  redrawGraphs();
});

window.addEventListener("DOMContentLoaded", () => {
  redrawAdsr(); // None of the graphs are drawn when the DOM first loads, so both redraw functions are called to draw the initial display
  redrawGraphs();
  document.querySelectorAll(`[class*="har "]`).forEach((h, index) => { // HTML for the harmonics, easier to do it this way so I could change the number of harmonics easily
    if (index < 1) h.innerHTML = `<h2>1</h2>\n<p>Ratio:</p>\n<p>1</p>\n<p>Amplitude:</p>\n<input type="text" id="h-ampl-1" value="1">\n<input type="text" style="visibility: hidden" id="spacer-input">\n<button onclick="hClear()">Clear</button>`;
    else h.innerHTML = `<h2>${index + 1}</h2>\n<p>Ratio:</p>\n<input type="text" id="h-ratio-${index + 1}">\n<p>Amplitude:</p>\n<input type="text" id="h-ampl-${index + 1}">\n<p>Phase:</p>\n<input type="text" id="h-phase-${index + 1}">`;
  });

  /* 
    The following loop iterates over each column of HTML that was just drawn by the forEach loop above, adding event listeners for the inputs
    The input event listeners have the following rules:  
    1. Clearing the ratio or amplitude will exclude the harmonic from any calculations by making one of the two undefined
    2. Clearing the phase will set that harmonic's phase to 0; if the phase is for some reason undefined, it will be forced to 0 in any calculations
    3. Ratios must be >= 1, amplitudes must be 0 <= x < 1, phases must be -0.5 <= x <= 0.5
    4. The only non-numeric (including decimal) character these inputs can accept is a single "/" for fractions
    5. The default background color is transparent, while invalid inputs will make the background color errColor
  */
  
  // *********************************************** 
  for (let i = 1; i <= 32; i++) {
    if (i != 1) { // Fundamental only has an amplitude input, not ratio or phase
      document.getElementById(`h-ratio-${i}`).addEventListener("input", h => {
        let val = h.target.value, int;

        if (val === "") {
          h.target.style.backgroundColor = "transparent";
          Global.harmonics[i - 1].r = undefined;
          redrawGraphs();
          return;
        }
        if (val.includes("/")) {
          let nums = val.trim().split("/");
          if (invalid(nums[0]) || invalid(nums[1])) {
            h.target.style.backgroundColor = errColor;
            return;
          } else {
            int = (nums[0] / nums[1]);
          }
        } else if (!invalid(val)) { 
          int = parseFloat(val.trim());
        } else {
          h.target.style.backgroundColor = errColor;
          return;
        }
      
        if (int < 1) {
          h.target.style.backgroundColor = errColor;
        } else {
          Global.harmonics[i - 1].r = int;
          h.target.style.backgroundColor = "transparent";
          redrawGraphs();
        }
      });

      document.getElementById(`h-phase-${i}`).addEventListener("input", h => {
        let val = h.target.value, int;

        if (val === "") {
          h.target.style.backgroundColor = "transparent";
          Global.harmonics[i - 1].p = 0;
          redrawGraphs();
          return;
        }
        
        if (val.includes("/")) {
          let nums = val.trim().split("/");
          if (invalid(nums[0]) || invalid(nums[1]) || nums.length > 2) {
            h.target.style.backgroundColor = errColor;
            return;
          } else {
            int = (nums[0] / nums[1]);
          }
        } else if (!zinvalid(val)) { 
          int = parseFloat(val.trim());
        } else {
          h.target.style.backgroundColor = errColor;
          return;
        }
      
        if (int < -0.5 || int > 0.5) {
          h.target.style.backgroundColor = errColor;
        } else {
          Global.harmonics[i - 1].p = int;
          h.target.style.backgroundColor = "transparent";
          redrawGraphs();
        }
      });
    }
    
    document.getElementById(`h-ampl-${i}`).addEventListener("input", h => {
      let val = h.target.value, int;

      if (val === "") {
        h.target.style.backgroundColor = "transparent";
        Global.harmonics[i - 1].a = undefined;
        redrawGraphs();
        return;
      }
       
      if (val.includes("/")) {
        let nums = val.trim().split("/");
        if (invalid(nums[0]) || invalid(nums[1])) {
          h.target.style.backgroundColor = errColor;
          return;
        } else {
          int = (nums[0] / nums[1]);
        }
      } else if (!invalid(val)) { 
        int = parseFloat(val.trim());
      } else {
        h.target.style.backgroundColor = errColor;
        return;
      }
      
      if (int > 1) {
        h.target.style.backgroundColor = errColor;
      } else {
        Global.harmonics[i - 1].a = int;
        h.target.style.backgroundColor = "transparent";
        redrawGraphs();
      }
    });
  }
  // ***********************************************
}); 

function hClear() { // Called by the "Clear" button on the first harmonic panel, resets all harmonic values that could be modified
  Global.harmonics[0][1] = 1;
  document.getElementById("h-ampl-1").value = "1";
  for (let i = 2; i <= 32; i++) {
    Global.harmonics[i - 1] = new Harmonic();
    document.getElementById(`h-ratio-${i}`).value = "";
    document.getElementById(`h-ampl-${i}`).value = "";
    document.getElementById(`h-phase-${i}`).value = "";
  }

  redrawGraphs();
}

function redrawAdsr() { // ADSR envelope drawing
  const adsr = document.getElementById("adsr-graph");
  const c = adsr.getContext("2d");
  const timesum = Global.att + Global.dec + 1 + Global.rel; // Total duration of the envelope with sustain fixed at 1s

  c.lineWidth = 4;
  c.strokeStyle = "#5DF714";
  c.beginPath(); 
  c.clearRect(0, 0, adsr.width, adsr.height); // Following (#, #)s are second quadrant cartesian coordinates to represent where the line is drawn
  c.moveTo(0, 0.99 * adsr.height); // Graph origin (0, 0); note that all points are vertically compressed to a 98% scale, leaving 1% buffer on the top and bottom, otherwise the lines would be covered by the canvas border
  c.lineTo(adsr.width * Global.att / timesum, 0.01 * adsr.height); // From envelope start to attack point (att, 1)
  c.lineTo(adsr.width * (Global.att + Global.dec) / timesum, adsr.height * (0.98 * (1 - Global.sus) + 0.01)); // From attack point to sustain start point (att + dec, sus);
  c.lineTo(adsr.width * (Global.att + Global.dec + 1) / timesum, adsr.height * (0.98 * (1 - Global.sus) + 0.01)); // From sustain start point to sustain end point (att + dec + 1, sus)
  c.lineTo(adsr.width, 0.99 * adsr.height); // From sustain end point to envelope end (att + dec + 1 + rel, 0)
  c.stroke();
}

document.getElementById("att").addEventListener("input", i => { // Attack slider on a whole number scale from 0-50
  Global.att = i.target.value / 25; // Range scaled to 0-2 for duration in seconds
  document.getElementById("atttext").innerText = "Attack: " + Global.att + "s";
  redrawAdsr();
});

document.getElementById("dec").addEventListener("input", i => { // Decay slider, same as above
  Global.dec = i.target.value / 25;
  document.getElementById("dectext").innerText = "Decay: " + Global.dec + "s";
  redrawAdsr();
});

document.getElementById("sus").addEventListener("input", i => { // Sustain slider on a whole number scale from 0-50
  Global.sus = i.target.value / 50; // Range scaled to 0-1 for amplitude ratio, relative to the attack which reaches 1 amplitude
  document.getElementById("sustext").innerText = "Sustain: " + Global.sus;
  redrawAdsr();
});

document.getElementById("rel").addEventListener("input", i => { // Release slider, same as attack and decay
  Global.rel = i.target.value / 25;
  document.getElementById("reltext").innerText = "Release: " + Global.rel + "s";
  redrawAdsr();
});

window.addEventListener("keydown", e => {
  if (document.activeElement.tagName == "INPUT") return; // Ignores keys pressed while an input is selected
  if (!Global.audioContext) Global.audioContext = initAudio(); // Audio context must be after page interaction
  if (playKeys.includes(e.key)) { 
    startPlay(e.key); 
    // Div class names are the key name, except for numeric keys which are "k#" since numbers are invalid class names
    const keydiv = isNaN(e.key) ? document.getElementById(e.key) : document.getElementById("k" + e.key);
    keydiv.style.transition = "none"; 
    keydiv.style.backgroundColor = "#36E51C";
  } else switch (e.key) {
    case "=": // "=" or "+" keys increase the volume by 10%
    case "+":
      if (Global.volume <= 90) Global.volume += 10; 
      else Global.volume = 100; // Prevents volume above 100%
      if (Global.ac) Global.audioContext.cmp.threshold.value = decibel(Global.volume);
      document.getElementById("vol").value = Global.volume;
      document.getElementById("voltext").innerText = Global.volume + "%";
      restartAudio();
      break;
    case "-": // "-" key decreases the volume by 10%
      if (Global.volume >= 10) Global.volume -= 10; 
      else Global.volume = 0; // Prevents volume below 0%
      if (Global.audioContext) Global.audioContext.cmp.threshold.value = decibel(Global.volume);
      document.getElementById("vol").value = Global.volume;
      document.getElementById("voltext").innerText = Global.volume + "%";
      restartAudio();
      break;
    case " ": // " " key resets page audio and releases any held keys
      restartAudio();
      break;
    default:
      return; 
  } 
});

window.addEventListener("keyup", e => {
  if (playKeys.includes(e.key)) { // Same procedure as the keydown listener, but for key releases
    stopPlay(e.key);
    
    const keydiv = isNaN(e.key) ? document.getElementById(e.key) : document.getElementById("k" + e.key);
    keydiv.style.transition = "background-color " + Global.rel + "s ease";
    keydiv.style.backgroundColor = "transparent";
  }
});

function startPlay(key) {
  if (!Global.playing[key] && !Global.blockPlaying) {
    const volAdj = Global.harmonics.reduce((acc, h) => zinvalid(h.r) || zinvalid(h.a) ? acc : acc + h.a, 0); 
    Global.playing[key] = { oscs: [], gs: [] }; 
    const now = Global.audioContext.audio.currentTime;
    Global.harmonics.forEach(h => { 
      if (!invalid(h.r) && !invalid(h.a)) {
        const freq = h.r * Global.ref * Math.pow(Math.pow(Global.equave, 1 / Global.divs), playKeys.indexOf(key) - 9); 
        if (freq >= 20000) return; // ratio * reference frequency * (key position - 9)^(equave^(1 / divs))                
        const osc = Global.audioContext.audio.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now);
        const g = Global.audioContext.audio.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(h.a * Global.volume / (100 * volAdj), now + Global.att);
        g.gain.linearRampToValueAtTime(h.a * Global.sus * Global.volume / (100 * volAdj), now + Global.att + Global.dec);
        
        let phase = zinvalid(h.p) ? 0 : h.p / freq;
        if (phase < 0) phase += 1 / freq; // Can't start the sound any time in the past relative to now
        if (phase !== 0) {
          const del = Global.audioContext.audio.createDelay();
          del.delayTime.setValueAtTime(phase, now);
          osc.connect(g).connect(del).connect(Global.audioContext.delay).connect(Global.audioContext.cmp).connect(Global.audioContext.audio.destination);
        } else osc.connect(g).connect(Global.audioContext.delay).connect(Global.audioContext.cmp).connect(Global.audioContext.audio.destination);
                
        osc.start(now);
        Global.playing[key].oscs.push(osc);
        Global.playing[key].gs.push(g);    
      }
    });
  }
}

function stopPlay(key) {
  if (Global.playing[key]) {
    if (!Global.audioContext) Global.audioContext = initAudio();
    const now = Global.audioContext.audio.currentTime;
    Global.playing[key].gs.forEach(g => {
      g.gain.cancelScheduledValues(0);
      g.gain.linearRampToValueAtTime(0, now + Global.rel);
    }); 
    Global.playing[key].oscs.forEach(osc => osc.stop(now + Global.rel));
    Global.playing[key] = undefined;
  }
}
