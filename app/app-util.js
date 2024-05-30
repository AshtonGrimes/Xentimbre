// This file is part of Xentimre, which is released under the GNU General Public License v3 or later.
// See the COPYING or LICENSE file in the root directory of this project or visit <http://www.gnu.org/licenses/gpl-3.0.html>.

function invalid(val) { return val == 0 || val == undefined || val == null || isNaN(val) }
function zinvalid(val) { return val == undefined || val == null || isNaN(val) }
function decibel(x) { return (30 * Math.log10(x + 20)) - 70 }
// function ratioToCents(r) { return 1200 * Math.log2(r) }
// function centsToRatio(c) { return Math.pow(2, c / 1200) }
const TAU = 2 * Math.PI;

// Long story short, I made this function by heavily modifying Sethares' parameterization to take an input as a frequency ratio over 1, and the output as a value 0-1
// This function assumes input ratios are relative to a reference pitch of 400 Hz
function disscalc(r) { return (Math.pow(23, 23 / 9) / (9 * Math.pow(14, 14 / 9))) * (Math.exp((-1680 / 137) * (r - 1)) - Math.exp((-2760 / 137) * (r - 1))) }

function log(fn, msg) { // For diagnostic console.log text, the format is [part] (message) where both are bold, [part] is # 851F9F, and (message) is # 000
   console.log(
    `%c[${fn}] %c${msg}`,
    "color: #851F9F; font-weight: bold", 
    "color: #000; font-weight: bold"
  );
}

function Harmonic(ratio, amplitude, phase) {
  this.r = ratio;
  this.a = amplitude;
  this.p = phase;
}
// Harmonic.prototype.complexAP = function() { return new Complex(this.a * -sin2pi(this.p), this.a * cos2pi(this.p)) }

function normalize(x) { return x - Math.round(x) } // Seems redundant to use this function here, but also used by .phase
function sin2pi(x) { return Math.sin(TAU * normalize(x)) }
function cos2pi(x) { return Math.cos(TAU * normalize(x)) }

function Complex(r, i) { 
  this.r = r; 
  this.i = i; 
}
Complex.prototype.abs = function() { return Math.sqrt(Math.pow(this.r, 2) + Math.pow(this.i, 2)) }
Complex.prototype.arg = function() { return Math.atan2(this.i, this.r) }
Complex.prototype.phase = function(p) { // -0.5 <= output <= 0.5, and relative to sines rather than cosines, along with a phase offset input
  let offset = zinvalid(p) ? 0 : p;
  return normalize((Math.atan2(-this.r, this.i) / TAU) + offset);
} 
Complex.prototype.conj = function() { return new Complex(this.r, -this.i) }
Complex.add = function(a, b) { return new Complex(a.r + b.r, a.i + b.i) }
Complex.sub = function(a, b) { return new Complex(a.r - b.r, a.i - b.i) }
Complex.mult = function(a, b) { return new Complex((a.r * b.r) - (a.i * b.i), (a.r * b.i) + (a.i * b.r)) }
Complex.twiddle = function(k, N) { return new Complex(cos2pi(k / N), -sin2pi(k / N)) }

Number.prototype.toComplex = function() { return new Complex(this.valueOf(), 0) }
// Only works for numeric arrays
Array.prototype.toComplex = function() { return this.map(x => typeof x !== "object" ? new Complex(x, 0) : x) }
Array.prototype.pad = function(input) {
  const minLen = (2 * this.length) - 1; // Chirp Z transform requres length 2N - 1 (technically N + M - 1),
  const newLen = Math.pow(2, Math.ceil(Math.log2(minLen))) - this.length;  // then FFT requires additional padding to the nearest power of two
  return this.concat(new Array(newLen).fill(input ?? 0)); 
}
Array.prototype.split = function() {
  return { // Split into two arrays of even and odd indices
    even: this.filter((_, i) => !(i % 2)), 
    odd: this.filter((_, i) => i % 2) 
  }
}

function Fourier(data, avg) { // Contains DFT/FFT data along with the average of the data
  this.data = data;
  this.avg = avg;
}
const IGNORE_AVG = 1, NYQUIST = 2;
Fourier.fft = function(data, mode) {
  if (data.length != Math.pow(2, Math.ceil(Math.log2(data.length))) || data.length < 2) 
    throw new RangeError("Input length must be a power of 2 greater than or equal to 2");
  const N = data.length;
  const split = Array.from(data).toComplex().split();
  const even = Fourier._fft_(split.even), odd = Fourier._fft_(split.odd);
  const evenResult = even.map((e, k) => Complex.add(e, Complex.mult(Complex.twiddle(k, N), odd[k])));
  const result = (mode === NYQUIST) ? evenResult : evenResult.concat(
    even.map((e, k) => Complex.sub(e, Complex.mult(Complex.twiddle(k, N), odd[k])))
  );     
  if (mode === IGNORE_AVG) return result;
  else return new Fourier(result, result.reduce((acc, x) => acc + x.abs(), 0) / result.length);
}
Fourier._fft_ = function(data) { // Only this function is used for recursive calls, since .fft has to handle the inital data array and modes
  const N = data.length;
  if (N == 1) return data;
  const split = data.split();
  const even = Fourier._fft_(split.even), odd = Fourier._fft_(split.odd);
  return even.map(
    (e, k) => Complex.add(e, Complex.mult(Complex.twiddle(k, N), odd[k]))
  ).concat(even.map(
    (e, k) => Complex.sub(e, Complex.mult(Complex.twiddle(k, N), odd[k]))
  ));
}
Fourier.ifft = function(data, mode) { // Excludes NYQUIST mode, not applicable
  if (data.length != Math.pow(2, Math.ceil(Math.log2(data.length))) || data.length < 2) 
    throw new RangeError("Input length must be a power of 2 greater than or equal to 2");
  const f = Fourier.fft(Array.from(data).toComplex().map(x => x.conj()), IGNORE_AVG);
  const result = f.map(x => Complex.mult(x.conj(), new Complex(1 / f.length, 0)));
  if (mode === IGNORE_AVG) return result;
  else return new Fourier(result, result.reduce((acc, x) => acc + x.abs(), 0) / result.length);
}
Fourier.czt = function(data, mode) { // https://web.ece.ucsb.edu/Faculty/Rabiner/ece259/Reprints/015_czt.pdf
  if (typeof data === "number") return data.toComplex();
  const N = Array.from(data).length;
  if (N === 1) return data;
  const x = Array.from(data).toComplex().pad(new Complex(0, 0));
  const L = x.length;
  const Y = Fourier.fft(
    new Array(N).fill().map( // y_n
      (_, i) => Complex.mult(x[i], Complex.twiddle(Math.pow(i, 2), 2 * N))
    ).pad(new Complex(0, 0)), 
    IGNORE_AVG
  );
  const V = Fourier.fft(
    new Array(L).fill().map((_, i) => { // v_n
      if (i < N) return Complex.twiddle(-Math.pow(i, 2), 2 * N);
      else if (i > L - N) return Complex.twiddle(-Math.pow(L - i, 2), 2 * N);
      else return new Complex(0, 0);
    }),
    IGNORE_AVG
  );
  const g = Fourier.ifft(new Array(L).fill().map((_, i) => Complex.mult(Y[i], V[i])), IGNORE_AVG);
  const preResult = g.map((x, k) => Complex.mult(x, Complex.twiddle(Math.pow(k, 2), 2 * N))).slice(0, N);
  const result = mode === NYQUIST ? preResult.slice(0, Math.floor(N / 2)) : preResult;
  if (mode === IGNORE_AVG) return result;
  else return new Fourier(result, result.reduce((acc, x) => acc + x.abs(), 0) / result.length);
}
