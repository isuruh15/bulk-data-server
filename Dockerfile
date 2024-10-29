FROM node:9-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app
RUN apk add --no-cache git
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install && mv node_modules ../
COPY . .
EXPOSE 9443
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "start"]
