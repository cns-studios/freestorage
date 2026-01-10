# Storage Bot Peer

This is a lightweight peer for the FreeStorage network. It acts as a storage node to help replicate chunks but does not track uptime or claim rewards.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```

## Usage

Run the bot:
```bash
node index.js
```

To run multiple bots (to simulate more peers), you can run the script in multiple terminals. Each instance generates a random UserID on startup.

## Features

-   **Auto-Authentication:** Connects to Content Server and registers as a peer.
-   **Keep-Alive:** Re-authenticates every 5 minutes to prevent timeout.
-   **Chunk Storage:** Saves chunks to `./storage/`.
-   **Chunk Retrieval:** Serves chunks to the network when requested.
