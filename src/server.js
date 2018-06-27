const path = require('path');
const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server, {serveClient: false});
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodeCleanup = require('node-cleanup');

nodeCleanup((exitCode, signal) => {
  console.log('Shutting down server...');
  const applicationData = {
    users: usersCache,
    challenges: challengeCache,
    games: gamesInProgress
  };
  const fileContent = JSON.stringify(applicationData, null, 2);
  fs.writeFileSync('./ApplicationData.json', fileContent);
  console.log('Data saved');
  console.log('Goodbye!');
});

const bcrypt = require('bcrypt');
const saltRounds = 10;
const jwtSigningSecret = 'RoyalGameOfUr';

const Game = require('./js/Game');
const CONFIG = require('./js/config');

// Serve the static content directly.
app.use(express.static(__dirname));
app.use(express.static(__dirname + '/static'));

app.get('/', function (req, res) {
  res.sendFile(__dirname + '/index.html');
});

server.listen({port: CONFIG.PORT}, () => {
  console.log('Listening on *:' + CONFIG.PORT);
});

// Models.
/**
 * Represents a user, should never be sent to the client as it contains sensitive
 * information.
 * @type {{id: number, name: string, email: string, password: string}}
 */
const UserModel = {};

/**
 * Represents a player, it is a stripped down version of the UserModel that doesn't
 * contain sensitive information.
 * @type {{id: number, name: string}}
 */
const PlayerModel = {};

const availablePlayers = {};

/**
 * Keyed by the Game ID with the game being the value.
 * @type {{}}
 */
let gamesInProgress = {};

/**
 * Keyed by the User ID, values are arrays containing Game IDs.
 * @type {{}}
 */
const playerGamesInProgress = {};

/**
 * A list of authenticated players in the lobby.
 * @type {{number: {id: number, name: string}}}
 */
const lobbyPlayers = {};

// socket.id => player.id
const socketIdsToPlayerIds = {};
// player.id => socket.id
const playerIdsToSocketIds = {};

// Prepare various caches.

/**
 * A cache of all user accounts.
 * @type {UserModel[]}
 */
let usersCache = [];

/**
 * A cache of all pending challenges.
 * @type {{id: string, from: number, to: number}}
 */
let challengeCache = {};
const sequences = {
  users: 0
};
if (fs.existsSync('./ApplicationData.json')) {
  const fileContent = fs.readFileSync('./ApplicationData.json');
  const applicationData = JSON.parse(fileContent);
  usersCache = applicationData.users;
  challengeCache = applicationData.challenges;
  sequences.users = applicationData.users.length;

  // Hydrate the game data back into objects that have functions.
  const rawGames = applicationData.games;
  const gameIds = Object.keys(rawGames);
  const gamesObjectified = {};
  for (let i = 0; i < gameIds.length; i++) {
    const gameData = rawGames[gameIds[i]];
    const newGameObject = new Game(gameData.player1.pid, gameData.player2.pid);

    // Copy the server state onto the client state.
    const gameProperties = ['id', 'turn', 'track', 'state', 'player1', 'player2', 'currentRoll', 'currentPlayer'];

    for (let p = 0; p < gameProperties.length; p++) {
      newGameObject[gameProperties[p]] = gameData[gameProperties[p]];
    }

    gamesObjectified[newGameObject.id] = newGameObject;
  }
  gamesInProgress = gamesObjectified;
}

io.on('connection', function (socket) {

  socket.on('disconnect', () => {
    // Handle the exit gracefully.
    setupGuest(socket);
  });

  // Check to see if the user is connecting with a remember token.
  const token = socket.handshake.query.rememberToken;

  if (token) {
    console.log(socket.id, 'connected with token');
    const tokenUser = getUserFromToken(token);

    if (tokenUser) {
      console.log(socket.id, 'token valid', tokenUser.id, tokenUser.name);
      // Tell the player they've logged in.
      socket.emit('auth-login-success', {
        id: tokenUser.id,
        name: tokenUser.name
      });

      setupPlayer(socket, tokenUser);
    } else {
      // todo: tell the client to destroy their token
      console.log(socket.id, 'token invalid');
      setupGuest(socket);
    }

  } else {
    setupGuest(socket);
  }

  function authLogin (payload) {
    console.log('authLogin ' + socket.id);

    // Retrieve user record.
    const loggingInAs = getUserByProperty('email', payload.email);

    if (!loggingInAs) {
      // todo: do a hash here anyway
      console.log('authLogin failure ' + socket.id);
      socket.emit('auth-login-failure', 'invalid username or password');
      return;
    }

    const hashOnRecord = loggingInAs['password'];

    bcrypt.compare(payload.password, hashOnRecord, (err, res) => {
      if (res === true) {
        // Did the user want to be remembered?
        let rememberToken = null;

        if (payload.remember === true) {
          // Generate the token using JWT (we can prevent tampering).
          // Stop the users email being readable in the JWT.
          const emailHash = crypto.createHash('sha256').update(loggingInAs.email).digest('hex');
          rememberToken = jwt.sign({
            userId: loggingInAs.id,
            userEmailHash: emailHash,
            userPasswordHash: loggingInAs.password,
          }, jwtSigningSecret, {
            expiresIn: '7d'
          });
        }

        // Success.
        console.log('authLogin success ' + socket.id);
        socket.emit('auth-login-success', {
          id: loggingInAs['id'],
          name: loggingInAs['name'],
          rememberToken: rememberToken
        });

        setupPlayer(socket, loggingInAs);

      } else {
        // Failure.
        console.log('authLogin failure ' + socket.id);
        socket.emit('auth-login-failure', 'invalid username or password');
      }
    });
  }

  function getUserFromToken (token) {
    // Decode the token.
    try {
      const payload = jwt.verify(token, jwtSigningSecret);
      const userId = payload.userId;

      const userOnRecord = getUserById(userId);

      // Verify that the user exists.
      if (!userOnRecord) {
        console.log(socket.id, 'token check user failed');
        return null;
      }

      // Verify that this is the right user for the token.
      if (payload.userPasswordHash !== userOnRecord['password']) {
        // The password hash didn't match. Either someone tampered with the token
        // or the user changed their password (they should log in again).
        console.log(socket.id, 'token check password failed');
        return null;
      }

      // Verify that the email hash is right for the user token.
      const existingEmailHash = crypto.createHash('sha256').update(userOnRecord['email']).digest('hex');

      if (existingEmailHash !== payload.userEmailHash) {
        // The token was likely tampered in this case.
        console.log(socket.id, 'token check email failed');
        return null;
      }

      // Everything looks good from here.
      return userOnRecord;

    } catch (err) {
      return null;
    }
  }

  function authRegister (payload) {
    console.log('authRegister ' + socket.id);

    const formValid = (payload.email && payload.name && payload.password);
    const passwordConfirmed = (payload.password === payload.passwordAgain);
    const emailInUse = (getUserByProperty('email', payload.email) !== null);
    const hashedPassword = bcrypt.hashSync(payload.password, saltRounds);

    console.log('after has result', hashedPassword);

    // Verify that we have an email, username, password, and confirmation.
    if (!formValid || !passwordConfirmed || hashedPassword === null || emailInUse) {
      let failureReason = 'unknown';
      if (!formValid) {
        failureReason = 'missing fields';
      } else if (!passwordConfirmed) {
        failureReason = 'passwords do not match';
      } else if (hashedPassword === null) {
        failureReason = 'server error';
      } else if (emailInUse) {
        failureReason = 'email in use';
      }

      console.log('authRegister failed ' + socket.id + ' ' + failureReason);
      socket.emit('auth-register-failure', failureReason);
      return;
    }
    console.log('authRegister success ' + socket.id);

    const newUser = {
      id: sequences.users++,
      name: payload.name,
      email: payload.email,
      password: hashedPassword,
    };

    usersCache.push(newUser);

    socket.emit('auth-register-success', {
      id: newUser.id,
      name: newUser.name
    });
  }

  function authLogout (socket) {
    console.log('logging out', socket.userId, socket.id);
    setupGuest(socket);
    socket.emit('auth-logout');
  }

  /**
   *
   * @param socket
   * @param {{id: number, name: string}} player
   */
  function setupPlayer (socket, player) {
    console.log('setting up player', player.name, socket.id);

    // Store some references that make converting between socket
    // and players a little easier.
    playerIdsToSocketIds[player.id] = socket.id;
    socketIdsToPlayerIds[socket.id] = player.id;

    // Remove guest events.
    socket.removeListener('login', authLogin);
    socket.removeListener('register', authRegister);

    // Registers player events.
    socket.on('logout', () => {
      authLogout(socket);
    });
    socket.on('challenge-create', (playerId) => {
      challengePlayer(socket, playerId);
    });
    socket.on('lobby-challenge-accept', challengeAccepted);
    socket.on('lobby-challenge-reject', challengeRejected);
    socket.on('game-select', (gameId) => {
      gameSelect(socket, gameId);
    });
    socket.on('game-roll', (gameId) => {
      gameRoll(socket, gameId);
    });

    // Mark the socket so we can identify the player.
    socket.userId = player.id;

    // Add this player to the list of currently playing players.
    lobbyPlayers[player.id] = player;

    // Send all the currently connected players to the user.
    sendAllPlayersToClient(socket);
    sendAllChallengesToClient(socket);
    sendAllGamesToPlayer(socket);

    // Let all the other users know that this user joined.
    socket.to('players').emit('lobby-players-join', {
      id: player.id,
      name: player.name
    });

    socket.leave('guests').join('players');
  }

  function setupGuest (socket) {

    socket.leave('players').join('guests');

    // Was this user logged in previously, or did they just join?
    if (socket.userId) {

      // Remove helper references.
      delete playerIdsToSocketIds[player.id];
      delete socketIdsToPlayerIds[socket.id];

      // This player is no longer in the lobby.
      delete lobbyPlayers[socket.userId];

      // Let everyone know they've left.
      const departingPlayer = getUserByProperty('id', socket.userId);
      socket.to('players').emit('lobby-players-left', {
        id: departingPlayer.id,
        name: departingPlayer.name
      });

      // Scrub the ID.
      socket.userId = null;
    }

    socket.on('login', authLogin);
    socket.on('register', authRegister);

    console.log(socket.id + ' authentication required');
    socket.emit('auth-required');

  }

  socket.on('game-move', function (details) {
    const gameState = gamesInProgress[details.gameId];

    if (gameState.state === 2) {
      // There is nothing we can do. The game is over now...
      return;
    }

    // Convert the track request back to an integer.
    details.track = parseInt(details.track);

    // Handy variables used in checks and updates.
    const currentPlayer = gameState.getCurrentPlayer();
    const currentEnemy = gameState.getEnemyPlayer();

    if (!gameState.isValidMove(details.track, details.lane)) {
      // Can't make this move.
      // Because the client should never present moves that aren't possible, if the
      // player has triggered this state then they're likely messing around in the
      // inspector. Force their client to update to a known good state.
      socket.emit('game-activity', gameState);

      // Nothing to do for now.
      return;
    }

    const destination = parseInt(details.track) + parseInt(gameState.currentRoll);

    // If we have reached the end then remove the token and increase the player score otherwise advance the token.
    if (destination === 15) {
      gameState.log(gameState.getCurrentPlayer().name + ' has got a token to the end!');
      currentPlayer.tokensDone += 1;
    } else {
      // Add the token to the new destination.
      gameState.track[destination] |= currentPlayer.number;
    }

    // Remove the token from its last position.
    gameState.track[details.track] ^= currentPlayer.number;

    // If we land on an enemy in the middle lane then they are knocked out.
    if (destination >= 5 && destination <= 12) {

      // If the cell we just landed on has an enemy inside of it...
      if ((gameState.track[destination] & currentEnemy.number) === currentEnemy.number) {

        // Remove them.
        gameState.track[destination] ^= currentEnemy.number;

        // Add the token back to their pile.
        currentEnemy.tokensWaiting += 1;
      }
    }

    // If we added a token to play then the token count decreases.
    if (details.track === 0) {
      currentPlayer.tokensWaiting -= 1;
    }

    // If we landed on a special square then we get another go.
    if ([4, 8, 14].indexOf(destination) >= 0) {
      gameState.log(gameState.getCurrentPlayer().name + ' landed on a special square and gets another go');

      // Reset the dice, we don't increment the turn counter if we get another go.
      // This way consecutive goes show under the same turn.
      gameState.currentRoll = null;
    } else {
      // Switch player.
      gameState.switchCurrentPlayer();

      // Reset the dice and increment the turn counter.
      gameState.nextTurn();
    }

    // Check to see if a player has won yet.
    if (currentPlayer.tokensDone === 7 || currentEnemy.tokensDone === 7) {
      // Game is over.
      gameState.state = 2;

      const winningPlayer = gameState.player1.tokensDone === 7 ? gameState.player1 : gameState.player2;

      gameState.log(winningPlayer.name + ' has won!');
      gameState.log('The game will be removed from your list shortly.');
      gameState.log('Thanks for playing!');

      setTimeout(() => {
        // In one minute destroy the game.
        delete gamesInProgress[gameState.id];

        // Tell the clients to remove the game from memory and the interface.
        player(gameState.player1.pid).emit('game-remove', gameState.id);
        player(gameState.player2.pid).emit('game-remove', gameState.id);
      }, 5000);
    }

    // Send a game update.
    player(gameState.player1.pid).emit('game-activity', gameState);
    player(gameState.player2.pid).emit('game-activity', gameState);
  });
});

function player (pid) {
  // Load details of the requested player.
  const player = getPlayerById(pid);

  if (!player) {
    throw new Error(`Tried to load player id '${pid}' but it could not be found.`);
  }

  const playerSocketId = playerIdsToSocketIds[pid];

  // If the player is offline then we aren't going to have their socket id.
  // In these cases we will send a stub socket back so that we don't have
  // to check in every place that the player sockets are used to see if
  // they actually are defined.
  if (!playerSocketId) {
    return {
      emit: function (event, payload) {
        console.log('emitting', event, 'to offline player', pid);
      },
      playerName: player.name
    };
  }

  // Return the actual socket for the player.
  return io.sockets.connected[playerSocketId];

}

/**
 * Start a game between two players.
 *
 * @param {PlayerModel} player1 Details of Player 1.
 * @param {PlayerModel} player2 Details of Player 2.
 */
function beginGame (player1, player2) {
  // We only allow one game between two unique players at a time.
  const gameId = [player1.id, player2.id].sort().join(':');

  if (gameId in gamesInProgress) {
    // Nothing to do.
    // The user would have been warned about a game in progress when creating the
    // challenge for the other player - they shouldn't reach this point.
    return;
  }

  const game = new Game(player1.id, player2.id);

  game.player1.name = player1.name;
  game.player2.name = player2.name;

  game.id = gameId;

  gamesInProgress[gameId] = game;

  let player1Roll, player2Roll;

  do {
    player1Roll = game.rollDice();
    player2Roll = game.rollDice();
  } while (player1Roll === player2Roll);

  game.player1.preGameRoll = player1Roll;
  game.player2.preGameRoll = player2Roll;

  game.log(player1.name + ' rolled a ' + player1Roll);
  game.log(player2.name + ' rolled a ' + player2Roll);

  if (player1Roll > player2Roll) {
    game.currentPlayer = game.player1.pid;
  } else {
    game.currentPlayer = game.player2.pid;
  }

  game.log(game.getCurrentPlayer().name + ' goes first!');

  // Increment after messages have been logged so pre-game messages show as
  // turn zero.
  game.turn += 1;
  game.state = 1;

  return game;
}

/**
 * Find a user record using the property and value.
 * If more than one exists, the first will be returned.
 *
 * @param {string} property The field to search.
 * @param {string|number} value The value to search for.
 * @returns {UserModel} The found user.
 */
function getUserByProperty (property, value) {
  for (let i = 0; i < usersCache.length; i++) {
    if (usersCache[i][property] === value) {
      return usersCache[i];
    }
  }
  return null;
}

/**
 * Find a user record with the specified id.
 *
 * @param {number} id The id of the user to find.
 * @returns {UserModel} The found user.
 */
function getUserById (id) {
  return getUserByProperty('id', id);
}

/**
 * Find a player record using the property and value.
 * If more than one exists, the first will be returned.
 *
 * @param {string} property The field to search.
 * @param {string|number} value The value to search for.
 * @returns {PlayerModel}
 */
function getPlayerByProperty (property, value) {
  const user = getUserByProperty(property, value);

  if (!user) {
    throw new Error(`Tried to getPlayerByProperty(${property}, ${value}) but it failed.`);
  }

  // A user contains account details like hashed password and email address.
  // The player object will strip out sensitive details so that the user can
  // be sent to other clients.
  return {
    id: user.id,
    name: user.name
  };
}

/**
 * Find a player record with the specified id.
 *
 * @param {number} id The id of the player to find.
 * @returns {PlayerModel} The found player.
 */
function getPlayerById (id) {
  return getPlayerByProperty('id', id);
}

function sendAllPlayersToClient (socket) {
  console.log('sending connected players to', socket.id);
  const playerIds = Object.keys(lobbyPlayers);
  const players = [];
  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const player = lobbyPlayers[playerId];

    players.push({
      id: player.id,
      name: player.name
    });
  }
  socket.emit('lobby-players-set', players);
}

function sendAllChallengesToClient (socket) {
  const challengeIds = Object.keys(challengeCache);
  const userChallenges = [];
  for (let i = 0; i < challengeIds.length; i++) {
    const challenge = challengeCache[challengeIds[i]];
    if (challenge.to === socket.userId) {
      const challenger = getUserById(challenge.from);
      userChallenges.push({
        challengerId: challenge.from,
        challengerName: challenger.name,
        challengeId: challenge.id
      });
    }
  }
  socket.emit('lobby-challenge-set', userChallenges);
}

function sendAllGamesToPlayer (socket) {
  const playerGames = [];

  const gameIds = Object.keys(gamesInProgress);

  for (let i = 0; i < gameIds.length; i++) {
    const game = gamesInProgress[gameIds[i]];

    if (game.player1.pid !== socket.userId && game.player2.pid !== socket.userId) {
      continue;
    }

    playerGames.push({
      gameId: game.id,
      turn: {
        number: game.turn,
        isYours: game.currentPlayer === socket.userId
      },
      currentPlayer: {
        id: game.getCurrentPlayer().pid,
        name: game.getCurrentPlayer().name
      },
      opponentName: game.getEnemyOfPlayerId(socket.userId).name
    });
  }

  // Send the list of games to the player.
  socket.emit('lobby-games-set', playerGames);
}

const challenges = {};

function challengePlayer (socket, playerId) {
  console.log('new challenge', socket.userId, 'is challenging', playerId);

  const challenger = getUserById(socket.userId);

  // Create a reference to uniquely identify this pair of users.
  const thisReference = [socket.userId, playerId].sort().join(':');

  if (thisReference in challengeCache) {
    // A challenge between these players is outstanding.

    // If the player being challenged already has an outstanding challenge
    // with the person challenging them, then accept the challenge.
    const existingChallenge = challengeCache[thisReference];
    if (existingChallenge.to === socket.userId) {
      // We're challenging the challenger - fight!
      challengeAccepted(existingChallenge.id);
    } else {
      // We're the one who sent the last challenge - nothing to do.
      const target = getPlayerById(playerId);
      socket.emit('lobby-challenge-exists', target.name);
      console.log('new challenge already exists');
      return;
    }
  }

  // Check that the players aren't already engaged in a game.
  if (thisReference in gamesInProgress) {
    // A game has been found.
    const target = getPlayerById(playerId);
    socket.emit('lobby-game-exists', target.name);
    return;
  }

  // todo: challenges expire after a while
  const newChallenge = {
    id: thisReference,
    from: socket.userId,
    to: playerId
  };

  challengeCache[newChallenge.id] = newChallenge;

  // Check to see if the player being challenged is currently online.
  if (playerId in playerIdsToSocketIds) {
    // The player appears to be online, we can send them a challenge event.
    const targetSocketId = playerIdsToSocketIds[playerId];
    socket.to(targetSocketId).emit('lobby-challenge-new', {
      challengerId: challenger.id,
      challengerName: challenger.name,
      challengeId: newChallenge.id
    });
    console.log('new challenge sent', targetSocketId);
  } else {
    console.log('new challenge player offline');
  }

  // If the player wasn't online, they should see the
  // challenge when they next log in.
}

function challengeAccepted (challengeId) {
  console.log('challenge accepted', challengeId);

  // Retrieve the challenge.
  const challenge = challengeCache[challengeId];

  const player1 = getPlayerById(challenge.from);
  const player2 = getPlayerById(challenge.to);

  // Remove the challenge as it is no longer needed.
  delete challengeCache[challengeId];

  const newGame = beginGame(player1, player2);

  if (!newGame) {
    // If the game already exists then beginGame doesn't return a game.
    // The user should never reach this state.
    return;
  }

  // Save the game to the cache.
  gamesInProgress[newGame.id] = newGame;

  // Notify the players that they have a new game.
  const newGamePayload = {
    gameId: newGame.id,
    turn: {
      number: newGame.turn,
      isYours: newGame.currentPlayer === player1.id
    },
    currentPlayer: {
      id: newGame.currentPlayer,
      name: newGame.getCurrentPlayer().name
    },
    opponentName: player2.name
  };

  player(player1.id).emit('lobby-games-add', newGamePayload);

  // Reconfigure for player 2.
  newGamePayload.turn.isYours = newGame.currentPlayer === player2.id;
  newGamePayload.opponentName = player1.name;

  player(player2.id).emit('lobby-games-add', newGamePayload);
}

function challengeRejected (challengeId) {
  console.log('challenge rejected', challengeId);
  // Remove the challenge.
  delete challengeCache[challengeId];
}

function gameSelect (socket, gameId) {
  console.log('game selected', gameId);
  const selectedGame = gamesInProgress[gameId];

  if (selectedGame) {
    console.log('game valid - sending');
    socket.emit('game-set', selectedGame);
  }
}

function gameRoll (socket, gameId) {
  console.log('game-roll', socket.userId, gameId);
  const game = gamesInProgress[gameId];

  if (game.currentPlayer !== socket.userId) {
    // Nothing to do.
    return;
  }

  if (game.currentRoll !== null) {
    // This player rolled already.
    return;
  }

  game.currentRoll = game.rollDice();
  game.log(game.getCurrentPlayer().name + ' rolled ' + game.currentRoll);

  if (game.currentRoll === 0) {
    // If the player rolled a zero then skip their turn, its back to the opponent to roll.
    game.log(game.getCurrentPlayer().name + ' misses a turn!');
    game.switchCurrentPlayer();
    game.nextTurn();
  } else if (!game.hasValidMoves()) {
    // Check if the player has any valid moves with this roll.
    game.log(game.getCurrentPlayer().name + ' has no valid moves');
    game.switchCurrentPlayer();
    game.nextTurn();
  }

  player(game.player1.pid).emit('game-activity', game);
  player(game.player2.pid).emit('game-activity', game);
}