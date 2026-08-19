const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

export function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength =
    bytes.length + 1 + ((64 - ((bytes.length + 9) % 64)) % 64) + 8;
  const input = new Uint8Array(paddedLength);
  const words = new Uint32Array(64);
  input.set(bytes);
  input[bytes.length] = 0x80;
  for (let index = 0; index < 8; index += 1) {
    input[paddedLength - 1 - index] =
      Math.floor((bytes.length * 8) / 2 ** (index * 8)) & 0xff;
  }

  let hash0 = 0x6a09e667;
  let hash1 = 0xbb67ae85;
  let hash2 = 0x3c6ef372;
  let hash3 = 0xa54ff53a;
  let hash4 = 0x510e527f;
  let hash5 = 0x9b05688c;
  let hash6 = 0x1f83d9ab;
  let hash7 = 0x5be0cd19;

  for (let offset = 0; offset < input.length; offset += 64) {
    for (let index = 0; index < 64; index += 1) {
      if (index < 16) {
        const byte = offset + index * 4;
        words[index] =
          (input[byte] << 24) |
          (input[byte + 1] << 16) |
          (input[byte + 2] << 8) |
          input[byte + 3];
      } else {
        const left = words[index - 15];
        const right = words[index - 2];
        const sigma0 =
          ((left >>> 7) | (left << 25)) ^
          ((left >>> 18) | (left << 14)) ^
          (left >>> 3);
        const sigma1 =
          ((right >>> 17) | (right << 15)) ^
          ((right >>> 19) | (right << 13)) ^
          (right >>> 10);
        words[index] =
          (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }
    }

    let [a, b, c, d, e, f, g, h] = [
      hash0,
      hash1,
      hash2,
      hash3,
      hash4,
      hash5,
      hash6,
      hash7
    ];
    for (let index = 0; index < 64; index += 1) {
      const sigma1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + sigma1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sigma0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      [h, g, f, e, d, c, b, a] = [
        g,
        f,
        e,
        (d + temp1) >>> 0,
        c,
        b,
        a,
        (temp1 + sigma0 + majority) >>> 0
      ];
    }
    [hash0, hash1, hash2, hash3, hash4, hash5, hash6, hash7] = [
      (hash0 + a) >>> 0,
      (hash1 + b) >>> 0,
      (hash2 + c) >>> 0,
      (hash3 + d) >>> 0,
      (hash4 + e) >>> 0,
      (hash5 + f) >>> 0,
      (hash6 + g) >>> 0,
      (hash7 + h) >>> 0
    ];
  }

  return [hash0, hash1, hash2, hash3, hash4, hash5, hash6, hash7]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}
