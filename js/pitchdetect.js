/*
The MIT License (MIT)

Copyright (c) 2014 João Vitor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

window.AudioContext = window.AudioContext || window.webkitAudioContext;

var audioContext = null;
var isPlaying = false;
var sourceNode = null;
var analyser = null;
var theBuffer = null;
var DEBUGCANVAS = null;
var mediaStreamSource = null;
var detectorElem,
	canvasElem,
	waveCanvas,
	pitchElem,
	noteElem,
	detuneElem,
	detuneAmount;

// ── Gráficos ──────────────────────────────────────────────────────────────────
var pitchChart = null;
var dbChart = null;
var MAX_CHART_POINTS = 150;

var pitchHistory = [];
var dbHistory    = [];
var labelHistory = [];

function initCharts() {
	var pitchCtx = document.getElementById('pitchChartCanvas');
	var dbCtx    = document.getElementById('dbChartCanvas');
	if (!pitchCtx || !dbCtx) return;

	var commonOpts = {
		responsive: true,
		maintainAspectRatio: false,
		animation: false,
		plugins: { legend: { display: false } },
		scales: {
			x: { display: false },
			y: {
				grid: { color: 'rgba(100,110,120,0.15)' },
				border: { display: false },
				ticks: { color: '#8a9aa8', font: { size: 11 } }
			}
		}
	};

	pitchChart = new Chart(pitchCtx, {
		type: 'line',
		data: {
			labels: [],
			datasets: [{
				label: 'Hz',
				data: [],
				borderColor: '#3ecfaa',
				borderWidth: 1.5,
				pointRadius: 0,
				tension: 0.35,
				fill: false,
				spanGaps: true
			}]
		},
		options: Object.assign({}, commonOpts, {
			scales: Object.assign({}, commonOpts.scales, {
				y: Object.assign({}, commonOpts.scales.y, {
					min: 50, max: 1200,
					ticks: Object.assign({}, commonOpts.scales.y.ticks, {
						callback: function(v) { return v + ' Hz'; }
					})
				})
			})
		})
	});

	dbChart = new Chart(dbCtx, {
		type: 'line',
		data: {
			labels: [],
			datasets: [{
				label: 'dB',
				data: [],
				borderColor: '#5b9cf6',
				borderWidth: 1.5,
				pointRadius: 0,
				tension: 0.35,
				fill: false,
				spanGaps: false
			}]
		},
		options: Object.assign({}, commonOpts, {
			scales: Object.assign({}, commonOpts.scales, {
				y: Object.assign({}, commonOpts.scales.y, {
					min: -80, max: 0,
					ticks: Object.assign({}, commonOpts.scales.y.ticks, {
						callback: function(v) { return v + ' dB'; }
					})
				})
			})
		})
	});
}

function pushChartPoint(pitchVal, dbVal) {
	var now = new Date().toLocaleTimeString('pt-BR', { hour12: false });

	labelHistory.push(now);
	pitchHistory.push(pitchVal);
	dbHistory.push(dbVal);

	if (labelHistory.length > MAX_CHART_POINTS) {
		labelHistory.shift();
		pitchHistory.shift();
		dbHistory.shift();
	}

	if (pitchChart) {
		pitchChart.data.labels            = labelHistory;
		pitchChart.data.datasets[0].data  = pitchHistory;
		pitchChart.update('none');
	}
	if (dbChart) {
		dbChart.data.labels            = labelHistory;
		dbChart.data.datasets[0].data  = dbHistory;
		dbChart.update('none');
	}
}
// ─────────────────────────────────────────────────────────────────────────────

window.onload = function() {
	audioContext = new AudioContext();
	MAX_SIZE = Math.max(4, Math.floor(audioContext.sampleRate / 5000));

	detectorElem  = document.getElementById('detector');
	canvasElem    = document.getElementById('output');
	DEBUGCANVAS   = document.getElementById('waveform');
	if (DEBUGCANVAS) {
		waveCanvas = DEBUGCANVAS.getContext('2d');
		waveCanvas.strokeStyle = 'black';
		waveCanvas.lineWidth = 1;
	}
	pitchElem    = document.getElementById('pitch');
	noteElem     = document.getElementById('note');
	detuneElem   = document.getElementById('detune');
	detuneAmount = document.getElementById('detune_amt');

	// drag-and-drop de arquivo de áudio
	detectorElem.ondragenter = function() { this.classList.add('droptarget'); return false; };
	detectorElem.ondragleave = function() { this.classList.remove('droptarget'); return false; };
	detectorElem.ondrop = function(e) {
		this.classList.remove('droptarget');
		e.preventDefault();
		theBuffer = null;
		var reader = new FileReader();
		reader.onload = function(event) {
			audioContext.decodeAudioData(event.target.result, function(buffer) {
				theBuffer = buffer;
			}, function() { alert('Erro ao carregar arquivo!'); });
		};
		reader.onerror = function(event) { alert('Erro: ' + reader.error); };
		reader.readAsArrayBuffer(e.dataTransfer.files[0]);
		return false;
	};

	fetch('whistling3.ogg')
		.then(function(response) {
			if (!response.ok) throw new Error('HTTP error, status = ' + response.status);
			return response.arrayBuffer();
		})
		.then(function(buffer) { return audioContext.decodeAudioData(buffer); })
		.then(function(decodedData) { theBuffer = decodedData; });

	// inicializa gráficos após o DOM estar pronto
	initCharts();
};

// ── Utilitários de nota ───────────────────────────────────────────────────────
var noteStrings = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function noteFromPitch(frequency) {
	var noteNum = 12 * (Math.log(frequency / 440) / Math.log(2));
	return Math.round(noteNum) + 69;
}

function frequencyFromNoteNumber(note) {
	return 440 * Math.pow(2, (note - 69) / 12);
}

function centsOffFromPitch(frequency, note) {
	return Math.floor(1200 * Math.log(frequency / frequencyFromNoteNumber(note)) / Math.log(2));
}

function noteToString(note) {
	var noteName = noteStrings[note % 12];
	var octave   = Math.floor(note / 12) - 1;
	return noteName + octave;
}

// ── Detecção de volume (dBFS) ─────────────────────────────────────────────────
/**
 * Calcula o volume RMS do buffer e retorna em dBFS.
 * Intervalo típico: -80 dB (silêncio) até 0 dB (sinal máximo).
 */
function calcDb(buf) {
	var rms = 0;
	for (var i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
	rms = Math.sqrt(rms / buf.length);
	if (rms < 1e-10) return -100;
	return Math.max(-80, 20 * Math.log10(rms));
}

function updateDbDisplay(db) {
	var dbEl  = document.getElementById('db_value');
	var barEl = document.getElementById('db_bar');
	if (!dbEl || !barEl) return;

	dbEl.textContent = Math.round(db) + ' dB';

	// barra de 0% (–80 dB) a 100% (0 dB)
	var pct = Math.max(0, Math.min(100, (db + 80) / 80 * 100));
	barEl.style.width = pct + '%';

	// cor muda conforme o nível
	if (db > -10)       barEl.style.background = '#e8614a'; // alto  → coral
	else if (db > -30)  barEl.style.background = '#e09940'; // médio → âmbar
	else                barEl.style.background = '#3ecfaa'; // baixo → teal
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Algoritmo ACF2+ ──────────────────────────────────────────────────────────
function autoCorrelate(buf, sampleRate) {
	var SIZE = buf.length;
	var rms  = 0;
	for (var i = 0; i < SIZE; i++) { var val = buf[i]; rms += val * val; }
	rms = Math.sqrt(rms / SIZE);
	if (rms < 0.01) return -1;

	var r1 = 0, r2 = SIZE - 1, thres = 0.2;
	for (var i = 0; i < SIZE / 2; i++)
		if (Math.abs(buf[i]) < thres) { r1 = i; break; }
	for (var i = 1; i < SIZE / 2; i++)
		if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }

	buf  = buf.slice(r1, r2);
	SIZE = buf.length;

	var c = new Array(SIZE).fill(0);
	for (var i = 0; i < SIZE; i++)
		for (var j = 0; j < SIZE - i; j++)
			c[i] = c[i] + buf[j] * buf[j + i];

	var d = 0;
	while (c[d] > c[d + 1]) d++;

	var maxval = -1, maxpos = -1;
	for (var i = d; i < SIZE; i++) {
		if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
	}
	var T0 = maxpos;

	var x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
	var a = (x1 + x3 - 2 * x2) / 2;
	var b = (x3 - x1) / 2;
	if (a) T0 = T0 - b / (2 * a);

	return sampleRate / T0;
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Loop principal ────────────────────────────────────────────────────────────
var rafID  = null;
var buflen = 2048;
var buf    = new Float32Array(buflen);

function updatePitch(time) {
	analyser.getFloatTimeDomainData(buf);

	// ── dB ──
	var db = calcDb(buf);
	updateDbDisplay(db);

	// ── debug canvas ──
	if (DEBUGCANVAS) {
		waveCanvas.clearRect(0, 0, 512, 256);
		waveCanvas.strokeStyle = 'red';
		waveCanvas.beginPath();
		[0, 128, 256, 384, 512].forEach(function(x) {
			waveCanvas.moveTo(x, 0); waveCanvas.lineTo(x, 256);
		});
		waveCanvas.stroke();
		waveCanvas.strokeStyle = 'black';
		waveCanvas.beginPath();
		waveCanvas.moveTo(0, buf[0]);
		for (var i = 1; i < 512; i++) waveCanvas.lineTo(i, 128 + buf[i] * 128);
		waveCanvas.stroke();
	}

	// ── pitch ──
	var ac = autoCorrelate(buf, audioContext.sampleRate);
	var pitchVal = null;

	if (ac === -1) {
		detectorElem.className = 'vague';
	} else {
		detectorElem.className = 'confident';
		var pitch = ac;
		pitchVal = Math.round(pitch);
		pitchElem.innerText = pitchVal;

		var note = noteFromPitch(pitch);
		document.getElementById('lastNote').innerHTML = noteToString(note);
		noteElem.innerHTML = noteToString(note);

		var detune = centsOffFromPitch(pitch, note);
		if (detune === 0) {
			detuneElem.className = '';
			detuneAmount.innerHTML = '--';
		} else {
			detuneElem.className = detune < 0 ? 'flat' : 'sharp';
			detuneAmount.innerHTML = Math.abs(detune);
		}
	}

	// ── gráficos ──
	pushChartPoint(pitchVal, Math.round(db));

	if (!window.requestAnimationFrame)
		window.requestAnimationFrame = window.webkitRequestAnimationFrame;
	rafID = window.requestAnimationFrame(updatePitch);
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Controles de fonte de áudio ───────────────────────────────────────────────
function startPitchDetect() {
	audioContext = new AudioContext();
	navigator.mediaDevices.getUserMedia({
		audio: {
			mandatory: {
				googEchoCancellation: 'false',
				googAutoGainControl: 'false',
				googNoiseSuppression: 'false',
				googHighpassFilter: 'false'
			},
			optional: []
		}
	}).then(function(stream) {
		mediaStreamSource = audioContext.createMediaStreamSource(stream);
		analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		mediaStreamSource.connect(analyser);
		updatePitch();
	}).catch(function(err) {
		console.error(err.name + ': ' + err.message);
		alert('Não foi possível acessar o microfone.');
	});
}

function toggleOscillator() {
	if (isPlaying) {
		sourceNode.stop(0);
		sourceNode = null;
		analyser   = null;
		isPlaying  = false;
		if (!window.cancelAnimationFrame)
			window.cancelAnimationFrame = window.webkitCancelAnimationFrame;
		window.cancelAnimationFrame(rafID);
		return 'use oscillator';
	}
	sourceNode = audioContext.createOscillator();
	analyser   = audioContext.createAnalyser();
	analyser.fftSize = 2048;
	sourceNode.connect(analyser);
	analyser.connect(audioContext.destination);
	sourceNode.start(0);
	isPlaying  = true;
	isLiveInput = false;
	updatePitch();
	return 'stop';
}

function toggleLiveInput() {
	if (isPlaying) {
		sourceNode.stop(0);
		sourceNode = null;
		analyser   = null;
		isPlaying  = false;
		if (!window.cancelAnimationFrame)
			window.cancelAnimationFrame = window.webkitCancelAnimationFrame;
		window.cancelAnimationFrame(rafID);
	}
	getUserMedia({
		audio: {
			mandatory: {
				googEchoCancellation: 'false',
				googAutoGainControl: 'false',
				googNoiseSuppression: 'false',
				googHighpassFilter: 'false'
			},
			optional: []
		}
	}, gotStream);
}

function togglePlayback() {
	if (isPlaying) {
		sourceNode.stop(0);
		sourceNode = null;
		analyser   = null;
		isPlaying  = false;
		if (!window.cancelAnimationFrame)
			window.cancelAnimationFrame = window.webkitCancelAnimationFrame;
		window.cancelAnimationFrame(rafID);
		return 'use demo audio';
	}
	sourceNode = audioContext.createBufferSource();
	sourceNode.buffer = theBuffer;
	sourceNode.loop   = true;
	analyser = audioContext.createAnalyser();
	analyser.fftSize  = 2048;
	sourceNode.connect(analyser);
	analyser.connect(audioContext.destination);
	sourceNode.start(0);
	isPlaying  = true;
	isLiveInput = false;
	updatePitch();
	return 'stop';
}
// ─────────────────────────────────────────────────────────────────────────────

function updateTargetHz() {
	var noteIndex  = parseInt(document.getElementById('selectNote').value);
	var octave     = parseInt(document.getElementById('selectOctave').value);
	var noteNumber = (octave + 1) * 12 + noteIndex;
	var frequency  = frequencyFromNoteNumber(noteNumber);
	document.getElementById('targetHz').innerText = frequency.toFixed(2);
}
