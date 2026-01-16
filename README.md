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
*Note: Ensure the data directory exists or is created by the init script.*

#### 2. Content Server

```bash
cd content-server
npm install
npm run init-db
npm start
```
Runs on port 8085 (HTTP) and 3002 (WebSocket).
*Note: Ensure the data directory exists or is created by the init script.*

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
./run_bots.sh 5
```
This script starts multiple bot instances defined in index.js or the shell script itself.
*Note: This script uses Docker to spawn bot containers. If you want to run a single bot node without Docker, you can run node index.js directly, optionally passing a suffix argument.*

#### 5. Desktop Client (Electron)

To run the client application:

```bash
cd electron-app
npm install
npm start
```

## Admin & User Management

### User Approval Process
For security and network management, all new user registrations are placed in a pending state. Users cannot log in or use the network until an administrator manually approves their account.

### Admin Tool
To manage pending user requests, use the included Admin Tool. This tool is intended to be run manually from the command line.

1. Navigate to the userdata-server directory:
   ```bash
   cd userdata-server
   ```
2. Start the admin interface:
   ```bash
   npm run admin
   ```
3. Access the web-based management panel at: http://localhost:3004

From here, you can approve or reject (delete) pending user registrations.

## Build and Release

The project includes a GitHub Actions workflow to automatically build the Electron application for multiple platforms and create a new release.

### Triggering a Release
To build and publish a new version:
1. Update the version in `electron-app/package.json`.
2. Push a tag starting with "v" to the repository:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

### Target Platforms
The build process generates production-ready binaries for:
- **Windows:** x64, x86, and ARM64 (.exe)
- **macOS:** Intel and Apple Silicon (.dmg and .zip)
- **Linux:** .deb, .rpm, .pacman, and .AppImage

*Note: As the application binaries are not code-signed, users may encounter security warnings during installation. Instructions for bypassing these warnings are provided in the release description.*

## Technical Details

-   **Encryption:** Files are encrypted client-side using AES-256-CBC before transmission. The server never sees the raw file content.
-   **Chunking:** Large files are split into 10MB chunks to facilitate distributed storage.
-   **Database:** SQLite is used for metadata storage in both Userdata and Content servers.