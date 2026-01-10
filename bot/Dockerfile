FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# The bot doesn't listen by default, but we'll expose a port if needed
EXPOSE 6001
CMD ["node", "index.js"]
