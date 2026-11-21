FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY index.html ./
COPY vite.config.ts tsconfig*.json ./
COPY src/ ./src/

ENV VITE_API_URL=http://localhost:4000

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
