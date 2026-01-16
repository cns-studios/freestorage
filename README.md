# FreeStorage

FreeStorage is a distributed, peer-to-peer experimental network designed for decentralized file storage. It utilizes a network of bots and community-run nodes to store data, with a central coordination system for authentication and peer discovery.

## Architecture

The system consists of several distinct components:

1.  **Userdata Server (Auth & Metadata):** Handles user registration, login, and tracks user storage quotas and credits. It acts as the central authority for user identity.
2.  **Content Server (Tracker & Coordination):** Manages file metadata (filename, size, chunks), coordinates file distribution among peers, and acts as the tracker for the P2P network. It maintains a WebSocket connection with peers to manage real-time availability.
3.  **Host Server (Web Interface):** Serves the public-facing website (landing page, TOS, policy).
4.  **Bot Network:** Automated node instances that participate in the network by storing chunks of data.
5.  **Electron App (Desktop Client):** The primary user interface for uploading and downloading files. It handles client-side encryption, chunking, and direct communication with the Content Server.

## Prerequisites

-   **Node.js** (v18 or higher)
-   **Docker** and **Docker Compose** (optional, for containerized deployment)
-   **NPM** (Node Package Manager)

## Setup & Installation

### Option 1: Docker Compose (Recommended for Servers)

This will start the Userdata Server, Content Server, and Host Server in a coordinated environment.

1.  Navigate to the project root.
2.  Run the following command:

    ```bash
    docker-compose up --build
    ```

3.  The services will be available at:
    -   **Host (Web):** http://localhost:8087
    -   **Content Server:** http://localhost:8085 (HTTP), ws://localhost:3002 (WebSocket)
    -   **Userdata Server:** http://localhost:8086

### Option 2: Manual Setup

If you prefer to run services individually or need to run the Desktop Client/Bots locally.

#### 1. Userdata Server

```bash
cd userdata-server
npm install
npm run init-db
npm start
```
Runs on port 8086 (default).
*Note: Ensure the `data` directory exists or is created by the init script.*

#### 2. Content Server

```bash
cd content-server
npm install
npm run init-db
npm start
```
Runs on port 8085 (HTTP) and 3002 (WebSocket).
*Note: Ensure the `data` directory exists or is created by the init script.*

#### 3. Host Server

```bash
cd host
npm install
npm start
```
Runs on port 8087.

#### 4. Bots (Storage Nodes)

To run the simulation of storage nodes:

```bash
cd bot
npm install
./run_bots.sh 5  # Starts 5 bot instances
```
This script starts multiple bot instances defined in `index.js` or the shell script itself.
*Note: This script uses Docker to spawn bot containers. If you want to run a single bot node without Docker, you can run `node index.js` directly, optionally passing a suffix argument.*

#### 5. Desktop Client (Electron)

To run the client application:

```bash
cd electron-app
npm install
npm start
```

## Usage

1.  **Start the Servers:** Ensure Userdata and Content servers are running (via Docker or manual).
2.  **Start the Bots:** Run the bot script to ensure there are peers available to store data.
3.  **Launch the App:** Open the Electron Desktop App.
4.  **Register:** Create a new account.
5.  **Upload:** Drag and drop files or use the upload button. Files are encrypted, chunked, and distributed to available bots.
6.  **Download:** Retrieve your files from the network. The client handles reassembly and decryption.

## Technical Details

-   **Encryption:** Files are encrypted client-side using AES-256-CBC before transmission. The server never sees the raw file content.
-   **Chunking:** Large files are split into 10MB chunks to facilitate distributed storage.
-   **Database:** SQLite is used for metadata storage in both Userdata and Content servers.
