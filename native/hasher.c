/*
 * B20MINER native PoW search loop (B20_POW_V1).
 *
 * preimage = "B20_POW_V1" (10) | chainId (32) | contract (20) | snapshotWallet (20)
 *          | miningWallet (20) | challenge (32) | nonce (32)            = 166 bytes
 * hash     = Keccak-256(preimage)   (Ethereum Keccak, pad 0x01 … 0x80)
 * valid    = hash <= target (both big-endian 256-bit)
 *
 * The first 134 bytes never change within a job. Nonces stay below 2^64, so
 * nonce bytes 0..23 are zero and the first 136-byte block is constant: it is
 * absorbed once, and each nonce costs a single Keccak-f[1600] permutation.
 *
 * Usage: b20miner-hasher <prefix134-hex> <target32-hex> <start-nonce-dec> <count-dec>
 * Output: "P <hashes>" progress lines, then "F <nonce> <hash-hex>" or "X <hashes>"
 * when <count> nonces were tried without a result. The caller re-verifies
 * every "F" line with pow-reference before submitting it.
 */
/* clock_gettime and CLOCK_MONOTONIC are POSIX; glibc hides them under -std=c11. */
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const uint64_t RC[24] = {
  0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
  0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
  0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
  0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
  0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
  0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
static const int ROTC[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
static const int PILN[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

#define ROTL(x, n) (((x) << (n)) | ((x) >> (64 - (n))))

static void keccakf(uint64_t st[25]) {
  uint64_t bc[5], t;
  for (int r = 0; r < 24; r++) {
    for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (int i = 0; i < 5; i++) {
      t = bc[(i + 4) % 5] ^ ROTL(bc[(i + 1) % 5], 1);
      for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    t = st[1];
    for (int i = 0; i < 24; i++) {
      int j = PILN[i];
      bc[0] = st[j];
      st[j] = ROTL(t, ROTC[i]);
      t = bc[0];
    }
    for (int j = 0; j < 25; j += 5) {
      for (int i = 0; i < 5; i++) bc[i] = st[j + i];
      for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
    }
    st[0] ^= RC[r];
  }
}

static uint64_t load64le(const uint8_t *p) {
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int parse_hex(const char *s, uint8_t *out, size_t n) {
  if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
  if (strlen(s) != n * 2) return -1;
  for (size_t i = 0; i < n; i++) {
    int hi = hexval(s[2 * i]), lo = hexval(s[2 * i + 1]);
    if (hi < 0 || lo < 0) return -1;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return 0;
}

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
  if (argc != 5) {
    fprintf(stderr, "usage: b20miner-hasher <prefix134-hex> <target32-hex> <start-nonce> <count>\n");
    return 2;
  }
  uint8_t prefix[134], target[32];
  if (parse_hex(argv[1], prefix, 134) || parse_hex(argv[2], target, 32)) {
    fprintf(stderr, "bad hex input\n");
    return 2;
  }
  char *end;
  uint64_t start = strtoull(argv[3], &end, 10);
  if (*end) return 2;
  uint64_t count = strtoull(argv[4], &end, 10);
  if (*end || count == 0 || start > UINT64_MAX - count) return 2;

  /* Block 1: preimage bytes 0..135 = prefix + two zero nonce bytes. */
  uint8_t block1[136];
  memcpy(block1, prefix, 134);
  block1[134] = 0;
  block1[135] = 0;
  uint64_t s1[25] = {0};
  for (int i = 0; i < 17; i++) s1[i] ^= load64le(block1 + 8 * i);
  keccakf(s1);

  /* Block 2: preimage bytes 136..165 (22 zero nonce bytes + 8-byte nonce), then padding. */
  uint8_t block2[136];
  memset(block2, 0, sizeof block2);
  block2[30] = 0x01;
  block2[135] = 0x80;

  uint64_t st[25];
  uint8_t hash[32];
  uint64_t tried = 0;
  double last = now_s();
  for (uint64_t i = 0; i < count; i++) {
    uint64_t nonce = start + i;
    for (int b = 0; b < 8; b++) block2[22 + b] = (uint8_t)(nonce >> (56 - 8 * b));
    memcpy(st, s1, sizeof st);
    for (int l = 0; l < 17; l++) st[l] ^= load64le(block2 + 8 * l);
    keccakf(st);
    for (int l = 0; l < 4; l++)
      for (int b = 0; b < 8; b++) hash[8 * l + b] = (uint8_t)(st[l] >> (8 * b));
    tried++;
    if (memcmp(hash, target, 32) <= 0) {
      printf("P %llu\nF %llu 0x", (unsigned long long)tried, (unsigned long long)nonce);
      for (int b = 0; b < 32; b++) printf("%02x", hash[b]);
      printf("\n");
      fflush(stdout);
      return 0;
    }
    if ((tried & 0xFFFF) == 0) {
      double t = now_s();
      if (t - last >= 0.25) {
        printf("P %llu\n", (unsigned long long)tried);
        fflush(stdout);
        last = t;
      }
    }
  }
  printf("P %llu\nX %llu\n", (unsigned long long)tried, (unsigned long long)tried);
  fflush(stdout);
  return 0;
}
