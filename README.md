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

This method starts the entire infrastructure: Userdata Server, Content Server, Host Server, a Cloudflare Tunnel for external access, and a simulated network of 5 storage bots.

#### 1. Configuration (.env)
Create a `.env` file in the project root to configure secrets and the tunnel token.

```bash
# .env file example

# Security Keys (Change these for production!)
SECRET_KEY=your_super_secret_jwt_key
INTERNAL_API_KEY=your_internal_service_key

# Cloudflare Tunnel Token (Required for public access)
# Get this from the Cloudflare Zero Trust dashboard when creating a tunnel.
TUNNEL_TOKEN=eyJhIjoi...

# Optional: Link to the latest client release
APP_DOWNLOAD_LINK=https://github.com/cns-studios/freestorage/releases/latest
```

#### 2. Cloudflare Tunnel Setup
The stack includes a `cloudflared` service to securely expose your local services to the internet without opening ports on your router.
1.  Go to the [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2.  Create a new Tunnel.
3.  Copy the connector token and paste it into your `.env` file as `TUNNEL_TOKEN`.
4.  Configure the public hostnames in Cloudflare to point to your services:
    *   `auth.yourdomain.com` -> `http://freestorage-userdata-server:8086`
    *   `tracker.yourdomain.com` -> `http://freestorage-content-server:8085`
    *   `ws.yourdomain.com` -> `http://freestorage-content-server:3002` (Enable WebSocket support)
    *   `www.yourdomain.com` -> `http://freestorage-host-server:8087`

#### 3. Running the Stack
Start all services in the background:

```bash
docker-compose up -d --build
```

To view logs for a specific service (e.g., the content server or a bot):
```bash
docker-compose logs -f content-server
docker-compose logs -f bot1
```

#### 4. Customization

**Scaling Bots:**
The default setup runs 5 bot instances (`bot1` through `bot5`). To add more:
1.  Open `docker-compose.yml`.
2.  Copy the `bot5` service block and rename it to `bot6`.
3.  Update the volumes to use a new directory:
    ```yaml
    volumes:
      - ./bot/instances/bot6:/bot-data
    ```
4.  Run `docker-compose up -d` to start the new container.

**Persistence:**
All data is persisted locally on the host machine:
*   **User Database:** `./userdata-server/data/userdata.db`
*   **Content Database:** `./content-server/data/content.db`
*   **Bot Storage:** `./bot/instances/botX/storage`
*   **Bot Credentials:** `./bot/instances/botX/credentials.json`

**Routing:**
*   The **Content Server** acts as the central coordinator.
*   **Bots** automatically connect to the Content Server via the internal Docker network (`ws://content-server:3002`).
*   **Cloudflare Tunnel** handles ingress traffic, routing external requests to the appropriate internal container.

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