FROM node:20-alpine
RUN apk add --no-cache dumb-init && mkdir -p /sandbox /tmp/sandbox && chown -R node:node /sandbox /tmp/sandbox
WORKDIR /sandbox
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/sandbox/run.js"]
