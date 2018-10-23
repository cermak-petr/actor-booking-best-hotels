FROM apify/actor-node-chrome

COPY . ./

RUN npm install --quiet --only=prod \
 && npm list

CMD [ "node", "main.js" ]
