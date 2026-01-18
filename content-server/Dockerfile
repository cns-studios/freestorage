FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install
COPY . .
EXPOSE 8085
EXPOSE 3002
CMD ["node", "index.js"]
