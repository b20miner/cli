# B20MINER CLI (Base Sepolia)

A terminal miner for **Launchpad tokens** on Base Sepolia. It keeps its own wallet on your computer: that wallet sends the proofs and pays each fee and gas. Every accepted proof credits the rewards wallet — the CLI's wallet, or your own wallet if you choose it at the first start (only its address; never its key) — and the mined tokens arrive there when the token's pool opens. Test network only: tokens here have no value. Full guide: [docs.b20miner.xyz/reference/cli](https://docs.b20miner.xyz/reference/cli/).

Creating tokens and trading stay on the Launchpad website (`launch.b20miner.xyz`).

## Install

```bash
npm install -g b20miner       # Node 20+; then type: b20miner
```

If npm says `EACCES` (macOS with the official Node installer), pick one:

- run the install with `sudo`;
- once, `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your PATH;
- use Node from nvm or Homebrew.

To try it without installing: `npx b20miner`.

The package ships no binaries. The fast native hasher is built once on first use from the bundled C source (`native/hasher.c`) if a C compiler exists; on macOS that means Apple's command line tools (`xcode-select --install`). Otherwise the CLI uses a slower built-in hasher.

### From the repository (development)

```bash
git clone https://github.com/b20miner/cli.git
cd cli
./install.sh
```

## Use

```bash
b20miner wallet create                  # wallet: shows address + private key once; then send it a little Base Sepolia ETH
b20miner tokens                         # tokens you can mine now: reward, fee, % mined, ends in
b20miner start TEST1                    # mine a token (symbol or address; remembered: next time b20miner start)
b20miner start TEST1 --workers 6        # choose CPU workers (default: half the cores)
b20miner start TEST1 --proofs 10        # stop after 10 accepted proofs
b20miner start TEST1 --max-cost 0.0003  # most one proof may cost incl. gas (default 0.0002 ETH)
b20miner start TEST1 --for 0xMINE       # mine for your own wallet (asks yes; --for self = the CLI wallet)
b20miner rewards [0xMINE|self]          # show or set where mined tokens go
b20miner status [TOKEN]                 # window, mined, the rewards wallet's share, tokens held, next step
b20miner claim TOKEN                    # claim the vested part into the CLI wallet (your own wallet claims on the Launchpad)
b20miner balance                        # ETH and mined tokens in the wallet
b20miner send TEST1 0xTO all            # send a token or ETH out of the wallet (asks yes first)
b20miner info                           # network, Launchpad contract, hasher, version
b20miner wallet show | key | delete     # address / private key again / remove
b20miner help [command]
```

Each proof pays the token's proof fee (0.0001 ETH on the current test tokens) plus gas. The CLI stops by itself when this wallet's quota or the token's reserve is mined, and waits by itself when an hourly release is mined out. When mining ends the relay finalizes the token and sends the tokens to the CLI wallet; with claim vesting the rest comes with `b20miner claim`.

Every token you name is checked against the Launchpad factory, so a look-alike token is never mined. The indexer only supplies the addresses on its mining list; each is checked against the factory and every name and figure is read from the chain (the chain alone when the indexer cannot be reached). Nothing else calls the indexer. Token names are cleaned of terminal control characters before printing. When two tokens share a symbol, `start` takes the one mining now, `claim`/`send` the one this wallet holds, otherwise the CLI asks for the address.

The CLI checks npm for a newer version (3-second limit; offline is fine). If the newest `b20miner` mines a different Launchpad, `b20miner start` refuses to mine and tells you to run `npm install -g b20miner@latest`. `B20MINER_NO_UPDATE_CHECK=1` turns the check off. Versions 0.2.x mined MINER for an owner wallet; 0.3.0 retires them.

The wallet is stored encrypted in `~/.b20miner/wallet.json`; the tokens you mined and the rewards wallet in `~/.b20miner/config.json`. Keep the private key you were shown; there is no password reset.

## Develop

```bash
npm ci
npm run build:hasher   # the native hasher (needs a C compiler); tests use it
npm test               # hasher vs the PoW test vectors, readiness, costs, update check
npm run typecheck
npm run build          # compile to dist/
npm pack               # the exact tarball npm would publish
```

`B20MINER_RPC_URL` points the CLI at another RPC, for example a local fork. `B20MINER_INDEXER_URL` sets the token-list indexer (empty: chain only). `B20MINER_HOME` moves `~/.b20miner`. `B20MINER_PASSWORD_FILE` supplies the password for unattended runs.

## License

MIT — see [LICENSE](LICENSE).
