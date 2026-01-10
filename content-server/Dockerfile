FROM node:18-alpine

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

# Initialize DB if not exists
RUN npm run init-db

EXPOSE 3002
EXPOSE 3003

CMD ["npm", "start"]
