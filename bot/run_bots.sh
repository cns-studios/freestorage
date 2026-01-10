#!/bin/bash

# Usage: ./run_bots.sh <number_of_bots> [action: start|stop|clean]
NUM_BOTS=${1:-1}
ACTION=${2:-start}
BASE_PORT=6000
NETWORK="freestorage_default"
IMAGE_NAME="freestorage-bot"

if [ "$ACTION" == "stop" ]; then
    for i in $(seq 1 $NUM_BOTS); do
        echo "Stopping bot$i..."
        docker stop "bot$i" && docker rm "bot$i"
    done
    exit 0
fi

if [ "$ACTION" == "clean" ]; then
    echo "Removing bot data..."
    rm -rf bot/instances
    exit 0
fi

# Build the bot image
echo "Building bot image..."
docker build -t $IMAGE_NAME ./bot

# Ensure network exists
docker network inspect $NETWORK >/dev/null 2>&1 || docker network create $NETWORK

for i in $(seq 1 $NUM_BOTS); do
    PORT=$((BASE_PORT + i))
    NAME="bot$i"
    
    # Create a local directory for this bot's data
    DATA_DIR="$(pwd)/bot/instances/$NAME"
    mkdir -p "$DATA_DIR/storage"
    
    # Ensure credentials file exists so it's not created as a directory by docker
    touch "$DATA_DIR/credentials.json"
    
    echo "Starting $NAME: Host Port $PORT -> Container Port 6001"
    
    docker run -d \
        --name "$NAME" \
        --network "$NETWORK" \
        -e WS_URL=ws://content-server:3002 \
        -v "$DATA_DIR/storage:/app/storage" \
        -v "$DATA_DIR/credentials.json:/app/credentials.json" \
        -p "$PORT:6001" \
        --restart unless-stopped \
        $IMAGE_NAME
done
