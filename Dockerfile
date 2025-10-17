# Use official Node.js LTS image
FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package.json package-lock.json ./
RUN npm install --production

# Copy source code
COPY . .

# Expose the port your app runs on (adjust if not 3000)
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]