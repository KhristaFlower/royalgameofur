// Make a copy of this file and call it 'config.js' changing the properties below as required.
exports.CONFIG = {

  // The is the URL that the client will connect to. Append the port as required.
  SERVER: 'http://localhost',

  // This is the port that the server will listen to connections on.
  PORT: 3000,

  // Set both of these options to enable SSL for the server.
  // If both options are set the server will be started on https.
  SSL: {

    // Certificate key path.
    KEY: null,

    // Certificate cert path.
    CERT: null

  },

  // Developer mode.
  DEV: false
};
