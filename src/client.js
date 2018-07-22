require('jquery/src/jquery');
require('./scss/ur.scss');
const Game = require('./js/Game');
const io = require('socket.io-client');

const debugSocketEvents = true;
const tokenMoveSpeed = 500;

// Create a placeholder game object.
let currentGameState = new Game(1, 2);

// Settings to use during socket setup.
let socketSettings = {};

const $authenticationOverlay = $('#authentication_overlay');

if (localStorage.getItem('remember-token')) {
  socketSettings = {
    query: {
      rememberToken: localStorage.getItem('remember-token')
    }
  };
}

/** @var {Socket} socket */
const socket = io(socketSettings);

let myPlayerId = null;

/**
 * A cache of all players currently connected.
 * @type {{id: number, name: string}[]}
 */
let lobbyPlayerList = [];

/**
 * A cache of pending challenges for the current player.
 * @type {{challengerId: number, challengerName: string, challengeId: string}[]}
 */
let pendingChallenges = [];

/**
 * A cache of the games we are involved in. This only contains the details required
 * to display the list of games this player is involved in, not the details about
 * the game its self (those are sent when the game is selected from the list).
 * @type {lobbyGameListItem[]}
 */
let lobbyGameList = [];

/**
 * This model is used to represent an overview of a game.
 * Used to display a menu showing all the games the player is playing in.
 * @type {{gameId: string, turn: {number: number, isYours: boolean}, currentPlayer: {id: number, name: string}, opponentName: string}}
 */
const lobbyGameListItem = {};

/**
 * The currently selected game, null if there is no game selected.
 * @type {?Game} The currently selected game.
 */
let currentGame = null;

const events = {
  auth: {
    /**
     * Usually sent when a client has connected without a remember token.
     */
    required: function () {
      if (debugSocketEvents) console.log('auth.required');
      $('#authentication_overlay').css('display', 'flex');
    },
    login: {
      /**
       * Received when we have logged in successfully.
       * @param {{id: number, name: string, rememberToken: ?string}} payload
       */
      success: function (payload) {
        if (debugSocketEvents) console.log(`auth.login.success ${payload.name} (${payload.id})`);

        // Clear the login form.
        $('.login-box form').trigger('reset');

        myPlayerId = payload.id;
        if (payload.rememberToken) {
          // Save the rememberToken for future use.
          localStorage.setItem('remember-token', payload.rememberToken);
        }
        if (localStorage.getItem('local-chat-' + myPlayerId)) {
          chatLog = JSON.parse(localStorage.getItem('local-chat-' + myPlayerId));
          if (debugSocketEvents) console.log('loaded chatLog', chatLog);
        }
        renderChat(true);

        // We're done with the authentication overlay.
        $('#authentication_overlay').hide();
      },
      /**
       * Sent when the authentication attempt made just before failed.
       * @param {string} failureReason
       */
      failure: function (failureReason) {
        if (debugSocketEvents) console.log('auth.login.failure', failureReason);
        showMessageBox('Authentication Failed', failureReason);
      }
    },
    register: {
      /**
       * Registration succeeded.
       * @param {{id: number, name: string}} newUser
       */
      success: function (newUser) {
        if (debugSocketEvents) console.log('auth.register.success', newUser);

        // Let the user know that registration worked.
        showMessageBox('Account Created', 'You may now log in.');

        // Move the email to the login form focus the login password input.
        $('#login_email').val($('#register_email').val());
        $('#login_password').focus();

        // Clear the registration form.
        $('.register-box form').trigger('reset');
      },
      /**
       * Registration failed.
       * @param {string} failureReason
       */
      failure: function (failureReason) {
        if (debugSocketEvents) console.log('auth.register.failure', failureReason);
        showMessageBox('Registration Failed', failureReason);
      }
    },
    /**
     * Sent when the user has requested to be logged out.
     */
    logout: () => {
      if (debugSocketEvents) console.log('auth.logout');
      loggedOut();
    }
  },
  lobby: {
    players: {
      /**
       * Server has sent a full list of all active players.
       * @param {{id: number, name: string}[]} connectedUsers
       */
      set: function (connectedUsers) {
        if (debugSocketEvents) console.log('auth.lobby.players.set', connectedUsers);
        lobbyPlayerList = connectedUsers;
        renderPlayerList();
      },
      /**
       * Server has told us that a player has joined the lobby.
       * @param {{id: number, name: string}} newPlayer
       */
      join: function (newPlayer) {
        if (debugSocketEvents) console.log('auth.lobby.players.join', newPlayer);
        // Check that the player isn't in the list already.
        // In some cases the joining player just refreshed the page and the server
        // didn't send a disconnect message but did send a join message.
        for (let i = 0; i < lobbyPlayerList.length; i++) {
          if (lobbyPlayerList[i].id === newPlayer.id) {
            // Nothing left to do, exit the function.
            return;
          }
        }
        // We didn't find them in the list, add the user and re-render.
        lobbyPlayerList.push(newPlayer);
        renderPlayerList();
      },
      /**
       * Server has told us that a player has left the lobby.
       * @param {{id: number, name: string}} player
       */
      left: function (player) {
        if (debugSocketEvents) console.log('auth.lobby.players.left', player);
        for (let i = 0; i < lobbyPlayerList.length; i++) {
          if (lobbyPlayerList[i].id === player.id) {
            lobbyPlayerList.splice(i, 1);
            break;
          }
        }
        renderPlayerList();
      }
    },
    challenge: {
      /**
       * The server sends this when another player has challenged us.
       * @param {{challengerId: number, challengerName: string, challengeId: string}} newChallenge
       */
      new: function (newChallenge) {
        if (debugSocketEvents) console.log('lobby.challenge.new', newChallenge);
        pendingChallenges.push(newChallenge);
        renderChallengeList();
      },
      /**
       * Received when there is already a challenge between the current user and
       * the target user.
       * @param {string} opponentName
       */
      exists: function (opponentName) {
        showMessageBox('Challenge Exists', `A challenge with ${opponentName} already exists.`);
      },
      /**
       * A list of all this user's challenges, usually sent on connection.
       * @param challenges
       */
      set: function (challenges) {
        if (debugSocketEvents) console.log('lobby.challenge.set', challenges);
        pendingChallenges = challenges;
        renderChallengeList();
      }
    },
    games: {
      /**
       * Usually sent when the client first connects and contains a list of all
       * games the player is in. This does not contain the game content.
       * @param {lobbyGameListItem[]} gameList
       */
      set: function (gameList) {
        if (debugSocketEvents) console.log('lobby.games.set', gameList);
        lobbyGameList = gameList;
        renderLobbyGameList();
      },
      /**
       * Sent when the player has been added to a new game.
       * @param {lobbyGameListItem} gameDetails
       */
      add: function (gameDetails) {
        if (debugSocketEvents) console.log('lobby.games.add', gameDetails);
        lobbyGameList.push(gameDetails);
        renderLobbyGameList();
      },
      /**
       * Sent when the player has finished with a game.
       * @param {lobbyGameListItem} gameDetails
       */
      remove: function (gameDetails) {
        if (debugSocketEvents) console.log('lobby.games.remove', gameDetails);
        for (let i = 0; i < lobbyGameList.length; i++) {
          if (lobbyGameList[i].gameId === gameDetails.gameId) {
            lobbyGameList.splice(i, 1);
            // Remove the local chat for that game.
            delete chatLog[gameDetails.gameId];
            break;
          }
        }
        renderLobbyGameList();
      },
      /**
       * Sent when the client challenged a player to a game when they're already
       * playing one together.
       * @param {string} otherPlayer The name of the player that was challenged.
       */
      exists: function (otherPlayer) {
        if (debugSocketEvents) console.log('lobby.games.exist', otherPlayer);
        showMessageBox('Challenge Refused', `Your challenge to ${otherPlayer} was refused because you are already playing a game with them.`);
      }
    }
  },
  game: {
    /**
     * Sent by the server when we want to set the game state to this directly.
     * @param {Game} gameData
     */
    set: function (gameData) {
      if (debugSocketEvents) console.log('game.set', gameData);
      const game = new Game(1, 2);
      game.hydrate(gameData);
      currentGame = game;
      renderGameBoard();

      // Render the chat for this game.
      renderChat(true);
    },
    /**
     * Sent by the server when another player did something to send us an update.
     * This method will chose to discard the information if the user isn't viewing
     * the game this update is for.
     * @param {{game: Game, delta: {move: {pid: int, t: int, m: int}}}} gameData
     */
    activity: function (gameData) {
      if (debugSocketEvents) console.log('game.activity', gameData);

      console.group('game.activity');

      const delta = gameData.delta;

      const game = new Game(0, 0);
      game.hydrate(gameData.game);

      if (currentGame !== null && currentGame.id === gameData.game.id) {
        // Check to see if players made a move we need to animate.
        // currentGame = game;

        // Copy everything over except for the track.
        const copyProps = Object.keys(game);
        copyProps.splice(copyProps.indexOf('track'), 1);
        for (let i = 0; i < copyProps.length; i++) {
          currentGame[copyProps[i]] = game[copyProps[i]];
        }

        renderGameBoard();
        renderTitle();

        // Create the animations if required.
        if ('move' in delta) {
          moveToken(currentGame.id, delta.move.pid, delta.move.t, delta.move.m)
            .then(() => {
              currentGame.track = game.track;
            });
        }

      } else {
        console.log('got activity for a game we\'re not looking at; updating sidebar only');
        // Update the sidebar with the new information.
        for (let i = 0; i < lobbyGameList.length; i++) {
          // Search for the existing game item.
          if (lobbyGameList[i].gameId === gameData.game.id) {
            // We found the game entry, hydrate a game object so we can use helper functions.
            lobbyGameList[i].currentPlayer.id = game.getCurrentPlayer().pid;
            lobbyGameList[i].currentPlayer.name = game.getCurrentPlayer().name;
            lobbyGameList[i].turn.number = game.turn;
            lobbyGameList[i].turn.isYours = game.currentPlayer === myPlayerId;
            lobbyGameList[i].opponentName = game.getEnemyOfPlayerId(myPlayerId).name;

            // Make sure the changes are applied.
            renderLobbyGameList();
            break;
          }
        }
      }
      console.groupEnd();
    },
    /**
     * Sent by the server to indicate a move has happened, this payload only contains
     * the information required to convey the changes and doesn't provide a full game
     * update.
     * @param {{gameId: string, event: string, data: {}}} payload
     */
    delta: function (payload) {
      console.log('game.delta', payload);
      if (payload.gameId !== currentGame.id) {
        // Nothing to do if this game isn't the current one.
        return;
      }

      const event = payload.event;
      const data = payload.data;

      if (event === 'move') {
        moveToken(payload.gameId, data.pid, data.t, data.m);
      }
    },
    /**
     * Sent from the server when the game has finished and a small amount of time
     * has passed so the game is being removed (client needs to update interface).
     * @param {string} gameId
     */
    remove: function (gameId) {
      // Remove the game from the game list.
      for (let i = 0; i < lobbyGameList.length; i++) {
        if (lobbyGameList[i].gameId === gameId) {
          lobbyGameList.splice(i, 1);
          break;
        }
      }
      renderLobbyGameList();

      // Clear the current game if it is the one being removed.
      if (currentGame.id === gameId) {
        currentGame = null;
        $('.board-container .end-game, .board-container .board').remove();
        $('.events .event-list').empty();

        $('.stats .turn .content').text('');
        $('.stats .current-player .content').text('');
        $('.stats .dice .content').text('');

        $('.stats .details .name').text('');
        $('.stats .details .pieces').empty();
      }
    }
  },
  chat: {
    /**
     * Sent from the server when a chat message needs to be sent to clients.
     * @param {MessageModel} message The message details.
     */
    add: function (message) {
      console.log('chat.add', message);

      if (!(message.gameId in chatLog)) {
        chatLog[message.gameId] = [];
      }
      chatLog[message.gameId].push(message);

      // Is this message for the chat we have open already?
      if (message.gameId === currentGame.id) {
        // We will only auto-scroll the box if the user hasn't
        // scrolled it from the bottom.
        const $chatList = $('.chat-list');
        const $chatContainer = $chatList.parent();

        const bottomOfBox = $chatContainer.height() + $chatContainer.scrollTop();
        const bottomOfList = $chatList.height() - 10;

        const scrollTheChat = bottomOfBox >= bottomOfList;
        console.log({bottomOfBox: bottomOfBox, bottomOfList: bottomOfList, scrollTheChat: scrollTheChat});
        renderChat(scrollTheChat);
      }
    },
    /**
     * Sent when the player connects to the server, it is to update any messages
     * that were accumulated while the player was offline.
     * @param {MessageModel[]} messages A list of offline messages.
     */
    update: function (messages) {
      console.log('chat.update', messages);

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (!(message.gameId in chatLog)) {
          chatLog[message.gameId] = [];
        }
        chatLog[message.gameId].push(message);
      }

      renderChat(true);
    }
  }
};

// Login
socket.on('auth-required', events.auth.required);
socket.on('auth-login-failure', events.auth.login.failure);
socket.on('auth-login-success', events.auth.login.success);

// Registration
socket.on('auth-register-failure', events.auth.register.failure);
socket.on('auth-register-success', events.auth.register.success);

// Logout
socket.on('auth-logout', events.auth.logout);

// Players
socket.on('lobby-players-join', events.lobby.players.join);
socket.on('lobby-players-left', events.lobby.players.left);
socket.on('lobby-players-set', events.lobby.players.set);

// Challenges
socket.on('lobby-challenge-new', events.lobby.challenge.new);
socket.on('lobby-challenge-exists', events.lobby.challenge.exists);
socket.on('lobby-challenge-set', events.lobby.challenge.set);

// Games
socket.on('lobby-games-set', events.lobby.games.set);
socket.on('lobby-games-add', events.lobby.games.add);
socket.on('lobby-games-remove', events.lobby.games.remove);
socket.on('lobby-game-exists', events.lobby.games.exists);

// Playing
socket.on('game-set', events.game.set);
socket.on('game-activity', events.game.activity);
socket.on('game-delta', events.game.delta);
socket.on('game-remove', events.game.remove);

// Social
socket.on('chat-add', events.chat.add);
socket.on('chat-update', events.chat.update);

let $boardTemplate;
let $svgBoard;
let $svgArrowHead;
let $svgArrowCorner;
let $svgArrowStraight;
let $svgArrowCap;

$(() => {
  $svgBoard = buildBoardSvg();
  $svgBoard.appendTo('.board-container');

  // Pre-render the SVG arrow graphics.
  preRenderSvgArrowParts();

  const originalBoardTemplate = '.board-container div.board';

  // Store a copy of the board template, it'll be a lot easier to edit this
  // than to create a new board each time we need to change it.
  $boardTemplate = $(originalBoardTemplate).clone().removeClass('start-hidden');

  // Get rid of the on-page element.
  $(originalBoardTemplate).remove();

  // Hook up the authentication page.
  $('#login_submit').on('click', doLogin);
  $('#register_submit').on('click', doRegister);

  $('form').on('submit', (event) => {
    // This seems to allow some password managers to prompt to save the site
    // even though we haven't changed pages.
    event.stopPropagation();
    event.preventDefault();
  });

  // Chat functionality.
  $('.chat input').off('keypress').on('keypress', function (e) {
    if (e.which === 13) {
      // Submit the message.
      sendChat();
    }
  });

  $('.chat button').off('click').on('click', function () {
    sendChat();
  });

  // Restore the chat when we get back.
  if (localStorage.getItem('local-chat-' + myPlayerId)) {
    chatLog = JSON.parse(localStorage.getItem('local-chat-' + myPlayerId));
  }

  // Help text.
  $('.stats .help').on('click', () => {
    const title = 'Game Help';
    let message = `The Royal Game Of Ur is an old board game.<br>
    <br>
    There are two players, you play as blue and your opponent plays as red.<br>
    <br>
    At the beginning of each turn the current player flips 4 coins, with one
    side of each granting one movement point. Those movement points show how
    far you can move one of your own tokens. If your movement roll results in
    zero points, you miss a turn.<br>
    <br>
    At first the tokens that enter the board are protected in a lane that only
    they can access. Once you reach the middle lane the enemy tokens could land
    on you which removes them from the board until you put them back on.<br>
    <br>
    There are special squares marked on the board which grant the landing player
    an extra move. The center marked square is protected and enemy tokens will
    not be able to land on you while you are there.<br>
    <br>
    Each cell may only contain one token. If you have no valid moves because your
    tokens block any that would be available then you will miss a turn.<br>
    <br>
    Once your token is towards the end of the board, you must roll an exact number
    that puts your token on the final square, you cannot over-shoot the end.<br>
    <br>
    The winner is the first player to get all their tokens to the other side of
    the board.`;

    showMessageBox(title, message);
  });
});

function doLogin () {
  console.log('doLogin');

  const email = $('#login_email').val();
  const password = $('#login_password').val();
  const remember = $('#login_remember').is(':checked');

  // Form fields will be emptied when the server responds with success or failure.
  socket.emit('login', {
    email: email,
    password: password,
    remember: remember
  });
}

function doRegister () {
  console.log('doRegister');

  const name = $('#register_name').val();
  const email = $('#register_email').val();
  const password = $('#register_password').val();
  const passwordAgain = $('#register_password_again').val();

  // Form fields will be emptied when the server responds with success or failure.
  socket.emit('register', {
    name: name,
    email: email,
    password: password,
    passwordAgain: passwordAgain
  });
}

// region Render Methods

function renderTitle() {

  let gameCount = 0;

  // Count the number of games that are pending the players input.
  for (let i = 0; i < lobbyGameList.length; i++) {
    if (lobbyGameList[i].currentPlayer.id === myPlayerId) {
      gameCount += 1;
    }
  }

  let title = '';

  if (gameCount) {
    title = `(${gameCount}) `;
  }

  title += 'The Royal Game Of Ur';

  $('title').text(title);
}

function renderPlayerList () {
  // Create the DOM.
  const $playerList = $('<ul>');
  $playerList.addClass('player-list');

  for (let i = 0; i < lobbyPlayerList.length; i++) {
    const $listItem = $('<li>');
    $listItem.text(lobbyPlayerList[i].name);
    $listItem.data('userId', lobbyPlayerList[i].id);
    $listItem.data('userName', lobbyPlayerList[i].name);
    $listItem.on('click', openPlayerMenu);

    // Always show the current player at the top of the list.
    if (lobbyPlayerList[i].id === myPlayerId) {
      $playerList.prepend($listItem);
    } else {
      $playerList.append($listItem);
    }
  }

  // Replace the DOM.
  $('ul.player-list').replaceWith($playerList);
}

function renderChallengeList() {
  // Create the DOM.
  const $newList = $('<ul class="challenge-list">');

  for (let i = 0; i < pendingChallenges.length; i++) {
    const $challengeItem = $('<li>')
      .text(pendingChallenges[i].challengerName)
      .data('userId', pendingChallenges[i].challengerId)
      .on('click', () => {
        const title = 'You have been challenged by ' + pendingChallenges[i].challengerName;
        const message = 'How do you respond to this challenge?';
        showAcceptDeclineCancel(title, message)
          .then((button) => {
            console.log('button pressed', button);
            if (button === 'accept') {
              console.log('challenge accepted', pendingChallenges[i].challengeId);
              socket.emit('lobby-challenge-accept', pendingChallenges[i].challengeId);
            } else if (button === 'decline') {
              console.log('challenge rejected', pendingChallenges[i].challengeId);
              socket.emit('lobby-challenge-reject', pendingChallenges[i].challengeId);
            }
            // With the exception of cancelling which is handled below,
            // we need to remove the challenge from our list and re-render.
            pendingChallenges.splice(i, 1);
            renderChallengeList();
          })
          .catch((button) => {
            // Do nothing.
            console.log('challenge dialog closed');
          });
      });

    $newList.append($challengeItem);
  }

  $('.my-games .challenge-list').replaceWith($newList);
}

function renderLobbyGameList() {
  const $gameList = $('<ul class="game-list">');

  for (let i = 0; i < lobbyGameList.length; i++) {
    const game = lobbyGameList[i];

    const $gameItem = $('<li class="my-game">').data('gameId', game.gameId);
    const $opponent = $('<div class="opponent">').text('vs ' + game.opponentName);
    const $bottom = $('<div class="bottom">');
    const $turn = $('<div class="turn">').text('Turn ' + game.turn.number);
    const whoseTurn = (game.turn.isYours ? 'Your' : 'Their');
    const $currentPlayer = $('<div class="current-player">').text(whoseTurn + ' turn');

    if (game.turn.isYours) {
      $gameItem.addClass('players-turn');
    }

    if (currentGame && game.gameId === currentGame.id) {
      $gameItem.addClass('current-game');
    }

    $gameItem.on('click', function () {
      console.log('game-select', $(this).data('gameId'));
      socket.emit('game-select', $(this).data('gameId'));
    });

    $bottom.append($turn, $currentPlayer);
    $gameItem.append($opponent, $bottom);
    $gameList.append($gameItem);
  }

  // Replace the existing list with the new one.
  $('ul.game-list').replaceWith($gameList);

  // The game list change, re-render the page title to reflect it.
  renderTitle();
}

function renderGameBoard() {
  console.group('renderGameBoard');

  const player1 = currentGame.player1;
  const player2 = currentGame.player2;

  const player = currentGame.getPlayerById(myPlayerId);
  const enemy = currentGame.getPlayerById(myPlayerId === player1.pid ? player2.pid : player1.pid);

  // Clear any classes from the board that are used to render the state.
  $('svg.cell').removeClass('valid player enemy');
  $('svg.arrow').remove();

  renderGameInformation(player, enemy);

  // Get the tokens that moved last turn, we'll use this to decide what needs to be animated.
  const waitingPlayerId = currentGame.getEnemyOfPlayerId(currentGame.currentPlayer).pid;
  const waitingPlayersLastMoves = currentGame.lastMoves[waitingPlayerId];
  console.log('waitingId', waitingPlayerId, 'lastMoves', waitingPlayersLastMoves);
  const lastMoves = currentGame.lastMoves[waitingPlayerId].map(function (item) {
    return item.split(':');
  });

  // Update token positions on the board.
  for (let i = 1; i <= 14; i++) {
    const trackValue = currentGame.track[i];

    if (trackValue === 0) {
      // No tokens on this cell.
      continue;
    }

    // Is there a player token on this spot?
    if ((trackValue & player.number) === player.number) {
      $('svg.cell.t-'+i+'.l-player').addClass('player');
    }

    // Is there an enemy token on this spot?
    if ((trackValue & enemy.number) === enemy.number) {
      $('svg.cell.t-'+i+'.l-enemy').addClass('enemy');
    }
  }

  // Mark the valid moves on the board for the current player if they rolled already.
  if (currentGame.currentPlayer === player.pid && currentGame.currentRoll) {
    const validMoves = currentGame.getValidMoves();

    for (let i = 0; i <= 14; i++) {
      if (validMoves[i] === true) {

        const arrowPath = Arrow.prototype.getArrowPath(i, currentGame.currentRoll, 'player');
        const arrow = new Arrow(arrowPath);

        const svgAttributes = {
          x: (tToX(i, 'p') + arrow.offset.x) * 100,
          y: (tToY(i, 'p') + arrow.offset.y) * 100
        };

        $('svg.cell.t-' + i + '.l-player')
          .addClass('valid')
          .after(arrow.svg.attr(svgAttributes).addClass('player'));
      }
    }
  }

  // Display the message of the game so far.
  const $newEventList = $('<ul class="event-list">');
  for (let i = 0; i < currentGame.messages.length; i++) {
    const isEvenTurnNumber = currentGame.messages[i].turn % 2 === 0;
    const $eventListItem = $('<li>').addClass(isEvenTurnNumber ? 'even-turn' : 'odd-turn');
    const $turnNumber = $('<span class="turn">').text('T' + currentGame.messages[i].turn);
    const $message = $('<div class="message">').text(currentGame.messages[i].message);
    $eventListItem.append($turnNumber, $message);
    $newEventList.prepend($eventListItem);
  }
  $('.events .event-list').replaceWith($newEventList);

  // Update the game list on the sidebar.
  const isPlayersTurn = currentGame.currentPlayer === myPlayerId;

  for (let i = 0; i < lobbyGameList.length; i++) {
    if (lobbyGameList[i].gameId === currentGame.id) {
      lobbyGameList[i].turn.number = currentGame.turn;
      lobbyGameList[i].turn.isYours = isPlayersTurn;
      lobbyGameList[i].currentPlayer.id = currentGame.currentPlayer;
      lobbyGameList[i].currentPlayer.name = currentGame.getCurrentPlayer().name;
      break;
    }
  }

  renderLobbyGameList();

  // Render arrows as hints to show the last moves.
  const pids = [player.pid, enemy.pid];
  for (let i = 0; i < pids.length; i++) {
    const lastMoves = currentGame.lastMoves[pids[i]];
    const playerTrack = pids[i] === myPlayerId ? 'player' : 'enemy';
    const trackShort = playerTrack.substr(0, 1);
    console.log('lastMoves for ' + playerTrack, lastMoves);
    for (let j = 0; j < lastMoves.length; j++) {
      const parts = lastMoves[j].split(':');
      const t = parts[0];
      const roll = parts[1];

      const moves = Arrow.prototype.getArrowPath(t, roll, playerTrack);
      const guideArrow = new Arrow(moves);

      const svgAttributes = {
        x: (tToX(t, trackShort) + guideArrow.offset.x) * 100,
        y: (tToY(t, trackShort) + guideArrow.offset.y) * 100
      };

      guideArrow.svg
        .attr(svgAttributes)
        .addClass(playerTrack)
        .addClass('guide')
        .appendTo($svgBoard);
    }
  }

  // Check for a victory condition.
  if (currentGame.state === 2) {
    // Somebody won!
    const winner = currentGame.player1.tokensDone === 7 ? currentGame.player1 : currentGame.player2;

    const $endGameBox = $('<div class="end-game">');
    const $victorContainer = $('<div class="victor-name">');
    const $nameSpan = $('<span>').text(winner.name);
    $victorContainer.append($nameSpan, ' wins!');
    $endGameBox.addClass(winner.pid === myPlayerId ? 'win' : 'loss');
    $endGameBox.append($victorContainer);

    $('.board-container').prepend($endGameBox);
  } else {
    // Remove any end-game boxes.
    $('.board-container .end-game').remove();
  }

  console.groupEnd();
}

function renderGameInformation(player, enemy) {
  // Update the stats at the top of the page.
  $('.stats .turn .content').text(currentGame.turn);
  $('.stats .current-player .content').text(currentGame.getCurrentPlayer().name);

  // Update the dice box.
  const $rollBox = $('.stats .dice').removeClass('go');
  const $rollContent = $('.stats .dice .content');

  if (currentGame.currentRoll) {
    $rollContent.text(currentGame.currentRoll);
  } else if (currentGame.currentPlayer === enemy.pid || currentGame.state === 2) {
    $rollContent.text('-');
  } else if (currentGame.currentPlayer === player.pid) {
    $rollContent.text('Roll!');
    $rollBox.addClass('go');
  }

  // Ensure the dice box has the right events if they're needed.
  if (!currentGame.currentRoll) {
    $rollBox.off('click').on('click', () => {
      console.log('sending dice roll');
      socket.emit('game-roll', currentGame.id);
    });
  }

  // Render the remaining tokens at the top of the board.
  const playerTokensDone = player.tokensDone;
  const enemyTokensDone = enemy.tokensDone;
  const $playerTokenContainer = $('<div class="pieces">');
  const $enemyTokenContainer = $('<div class="pieces">');

  for (let i = 0; i < 7; i++) {
    const $playerToken = $('<div class="token">');
    const $enemyToken = $('<div class="token">');
    if (i < playerTokensDone) {
      $playerToken.addClass('done');
    }
    if (i < enemyTokensDone) {
      $enemyToken.addClass('done');
    }
    $playerTokenContainer.prepend($playerToken);
    $enemyTokenContainer.append($enemyToken);
  }

  $('.stats .details .player .pieces').replaceWith($playerTokenContainer);
  $('.stats .details .enemy .pieces').replaceWith($enemyTokenContainer);
  $('.stats .details .player .name').text(player.name);
  $('.stats .details .enemy .name').text(enemy.name);
}

function openPlayerMenu () {
  const playerId = $(this).data('userId');
  const playerName = $(this).data('userName');

  // Build the dialog.
  const $overlay = $('<div class="overlay player-menu-overlay">');
  const $wrapper = $('<div class="overlay-wrapper">');
  const $playerMenu = $('<div class="player-menu">');
  const $heading = $('<div class="heading">').text(playerName);
  const $optionsMenu = $('<ul class="options">');
  const $closeButton = $('<div class="close">').text('Close');

  if (playerId === myPlayerId) {
    // Show different options if the player clicks on them self.
    const $logoutButton = $('<li class="logout">').text('Logout');
    $optionsMenu.append($logoutButton);
  } else {
    // Show interactions with other players.
    const $challengeButton = $('<li class="challenge">').text('Challenge');
    $optionsMenu.append($challengeButton);
  }

  $playerMenu.append($heading, $optionsMenu, $closeButton);
  $wrapper.append($playerMenu);
  $overlay.append($wrapper);

  function hideOverlay () {
    $overlay.remove();
  }

  // Allow the overlay to be dismissed when clicking outside the box.
  $overlay.on('click', hideOverlay);
  $overlay.find('.close').on('click', hideOverlay);

  // Prevent propagation will stop clicks on the menu from triggering
  // the overlay closing.
  $overlay.find('.player-menu').on('click', stopPropagation);

  $overlay.find('.challenge').off('click').on('click', () => {
    const title = 'Challenge ' + playerName;
    const message = 'Send a challenge request to ' + playerName + '?';
    showOkCancel(title, message)
      .then((button) => {
        console.log('challenge confirmation confirmed', playerId);
        socket.emit('challenge-create', playerId);
        // Hide the user overlay once a challenge has been sent.
        $overlay.remove();
      })
      .catch((button) => {
        console.log('challenge confirmation cancelled');
      });
  });

  $overlay.find('.logout').off('click').on('click', () => {
    const title = 'Logout?';
    const message = 'Are you sure you wish to logout?';
    showOkCancel(title, message)
      .then((button) => {
        console.log('logout confirmed');
        socket.emit('logout');
      })
      .catch((button) => {
        console.log('logout cancelled');
      })
  });

  // Display the overlay.
  $('body').append($overlay);
}

function stopPropagation(event) {
  event.stopPropagation();
}

function showMessageBox (title, message) {
  // Create a message box.
  const $overlay = $('<div class="overlay">');
  const $wrapper = $('<div class="overlay-wrapper">');

  function dismissOverlay () {
    $overlay.remove();
  }

  const $okButton = $('<button>').text('OK').on('click', dismissOverlay);
  const $controls = $('<div class="controls">');
  $controls.append($okButton);

  const $title = $('<div class="heading">').text(title);
  const $body = $('<p>').html(message);
  const $messageBox = $('<div class="container">').on('click', stopPropagation);
  $messageBox.append($title, $body, $controls);

  $wrapper.append($messageBox);
  $overlay.append($wrapper);
  $overlay.on('click', dismissOverlay);

  // Add the overlay to the page.
  $('body').append($overlay);
}

function showOkCancel (title, message) {
  return new Promise((resolve, reject) => {
    // Create a message box.
    const $overlay = $('<div>');
    $overlay.addClass('overlay');

    function dismissOverlay () {
      $overlay.remove();
      reject();
    }

    const $messageBox = $('<div>');
    $messageBox.addClass('container');
    $messageBox.on('click', stopPropagation);

    const $title = $('<div>');
    $title.addClass('heading');
    $title.text(title);

    const $body = $('<p>');
    $body.text(message);

    const $controls = $('<div>');
    $controls.addClass('controls');

    const $okButton = $('<button>');
    $okButton.text('OK');
    $okButton.on('click', () => {
      $overlay.remove();
      resolve('ok');
    });

    const $cancelButton = $('<button>');
    $cancelButton.text('Cancel');
    $cancelButton.on('click', dismissOverlay);

    $controls.append($cancelButton, $okButton);
    $messageBox.append($title, $body, $controls);
    $overlay.append($messageBox);
    $overlay.on('click', dismissOverlay);

    $('body').append($overlay);
  });
}

function showAcceptDeclineCancel (title, message) {
  return new Promise((resolve, reject) => {
    // Create a message box.
    const $overlay = $('<div>');
    $overlay.addClass('overlay');

    function dismissOverlay () {
      $overlay.remove();
      reject();
    }

    const $messageBox = $('<div>').addClass('container').on('click', stopPropagation);
    const $title = $('<div>').addClass('heading').text(title);
    const $body = $('<p>').text(message);
    const $controls = $('<div>').addClass('controls');

    const $acceptButton = $('<button>').text('Accept').on('click', () => {
      $overlay.remove();
      resolve('accept');
    });

    const $declineButton = $('<button>').text('Decline').on('click', () => {
      $overlay.remove();
      resolve('decline');
    });

    const $cancelButton = $('<button>').text('Cancel').on('click', dismissOverlay);

    $controls.append($cancelButton, $declineButton, $acceptButton);
    $messageBox.append($title, $body, $controls);
    $overlay.append($messageBox);
    $overlay.on('click', dismissOverlay);

    $('body').append($overlay);
  });
}

// endregion

/**
 * Called to end the users session by clearing client variables and changing the UI.
 */
function loggedOut() {
  myPlayerId = null;
  lobbyPlayerList = [];
  lobbyGameList = [];
  pendingChallenges = [];
  currentGameState = null;

  // Destroy the remember token if the player logged out.
  localStorage.removeItem('remember-token');

  // Remove the player menu if it was open, it'll not be needed now.
  $('.player-menu-overlay').remove();

  // Show the authentication box.
  $authenticationOverlay.show();

  // Clear the chat log (it is saved when changes are made, so we don't need to do it here).
  chatLog = {};

  // Render interfaces that need to be updated after logout.
  renderChat(false);
  renderTitle();
}

// Local cache of chat made in all the games the player is a part of.
// Chat will be thrown away once the game is complete.
// If a player logs off then chat messages will be collected on the
// server and sent to the client once they log back in.
let chatLog = {};

/**
 * A message object.
 * @type {{gameId: string, senderId: number, senderName: string, message: string}}
 */
const MessageModel = {};

/**
 * Render the chat box to show the current message list.
 * @param {boolean} scrollToBottom Should the container be scrolled down to the new message?
 */
function renderChat(scrollToBottom) {
  const $chatList = $('.chat-list');

  // Nothing to render if we don't have a game open.
  if (currentGame === null || !(currentGame.id in chatLog)) {
    // If the chat is open, clear it.
    $chatList.empty();
    return;
  }

  const currentChat = chatLog[currentGame.id];

  // Write the chat to the localStorage so we can pull it back if the player
  // closes the browser. We don't want to store all that chat history on the server.
  localStorage.setItem('local-chat-' + myPlayerId, JSON.stringify(chatLog));

  const $newChatList = $('<ul class="chat-list">');

  for (let i = 0; i < currentChat.length; i++) {
    const $chatItem = $('<li>');
    const $playerName = $('<div class="name">').text(currentChat[i].senderName);
    const $playerMessage = $('<div class="message">').text(currentChat[i].message);

    $chatItem.append($playerName, $playerMessage);
    $newChatList.append($chatItem);
  }

  $chatList.replaceWith($newChatList);

  if (scrollToBottom) {
    scrollChat();
  }
}

/**
 * Scroll the chat box to to the bottom.
 */
function scrollChat() {
  $('.chat-container').scrollTop($('.chat-list').height());
}

/**
 * Send the contents of the chat input to the other player.
 */
function sendChat() {

  if (currentGame === null) {
    return;
  }

  const $chatInput = $('.chat input');
  const message = $chatInput.val();

  if (message.trim().length === 0) {
    return;
  }

  console.log('sending chat');

  socket.emit('chat-send', {
    gameId: currentGame.id,
    message: message
  });

  // Clear the text box.
  $chatInput.val('');
}

function buildBoardSvg() {

  const $svg = $('<svg version="1.1" xmlns="http://www.w3.org/2000/svg">').attr({
    width: '100%',
    height: '100%',
    viewBox: '0 0 800 300'
  }).addClass('board');

  $(svgEl('rect')).attr({
    width: '800',
    height: '300',
    fill: '#ccc'
  }).appendTo($svg);

  // Create the bulk of the game board.
  const trackInfo = getTrackInfo();
  for (let i = trackInfo.length - 1; i >= 0; i--) {
    // Build the SVG square to contain all the information it needs.
    const $svgSquare = generateSvgSquare(trackInfo[i]);
    $svgSquare.addClass('cell');
    $svgSquare.data({
      t: trackInfo[i].t,
      tid: trackInfo[i].t + trackInfo[i].l.substr(0, 1)
    }).addClass('t-' + trackInfo[i].t)
      .addClass('l-' + trackInfo[i].l);

    if (trackInfo[i].t >= 5 && trackInfo[i].t <= 12) {
      $svgSquare.addClass('l-player').addClass('l-enemy')
    }

    $svgSquare.appendTo($svg);
  }

  // Render walls between cells.
  const innerWalls = 'M100,200 L700,200 M100,100 L700,100 M400,100 L400,0 M600,100 L600,0 M400,300 L400,200 M600,300 L600,200';
  const edgeWalls = 'M400,0 L0,0 L0,300 L400,300 M600,0 L800,0 L800,300 L600,300';

  $(svgEl('path')).attr({
    d: innerWalls,
    stroke: '#979797',
    'stroke-width': 3,
    fill: 'none'
  }).appendTo($svg);

  $(svgEl('path')).attr({
    d: edgeWalls,
    stroke: '#979797',
    'stroke-width': 5,
    fill: 'none'
  }).appendTo($svg);

  return $svg;
}

function animateToken(t, m, p) {
  return new Promise((resolve) => {
    // Create the path that the token will follow.
    const path = getPath(t, m, p);

    // Calculate the time we should animate for.
    const moveTime = tokenMoveSpeed * m;

    // Create the CSS that will animate the token.
    const cssAnimation = {
      motionPath: `path('${path}')`,
      offsetPath: `path('${path}')`,
      animation: `move ${moveTime}ms linear`
    };

    const circleDetails = {
      cx: 0,
      cy: 0,
      r: 22
    };

    // Make the token that we need to animate.
    const $token = $(svgEl('circle'))
      .attr(circleDetails)
      .css(cssAnimation)
      .addClass('ani-token')
      .addClass(p === 'p' ? 'player' : 'enemy')
      .appendTo($svgBoard);

    // We need to remove the token once the animation has ended.
    setTimeout(() => {
      $token.remove();
      resolve();
    }, moveTime);
  });
}

window.animateToken = animateToken;

function getPath(track, moves, lane) {

  const coordinates = {
    p: [
      '450 250', '350 250', '250 250', '150 250', '50 250',
      '50 150', '150 150', '250 150', '350 150', '450 150', '550 150', '650 150', '750 150',
      '750 250', '650 250', '550 250'
    ],
    e: [
      '450 50', '350 50', '250 50', '150 50', '50 50',
      '50 150', '150 150', '250 150', '350 150', '450 150', '550 150', '650 150', '750 150',
      '750 50', '650 50', '550 50'
    ]
  };

  const parts = [];

  const last = parseInt(track) + parseInt(moves);

  const quadSize = 20;

  const bends = [4, 5, 12, 13];

  for (let i = track; i <= last; i++) {
    const letter = i === track ? 'M' : 'L';

    const coordinatePair = coordinates[lane][i].split(' ');
    const c = {
      x: parseInt(coordinatePair[0]),
      y: parseInt(coordinatePair[1])
    };

    if (i === last) {
      parts.push(`${letter} ${c.x} ${c.y}`);
    } else if (bends.indexOf(i) >= 0 && i !== track) {
      // If we're on a corner piece we will need to make a bend.

      let adj = {
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 }
      };

      if (i === 4) {
        adj.start.x = quadSize;
        adj.end.y = lane === 'p' ? -quadSize : quadSize;
      } else if (i === 5) {
        adj.start.y = lane === 'p' ? quadSize : -quadSize;
        adj.end.x = quadSize;
      } else if (i === 12) {
        adj.start.x = -quadSize;
        adj.end.y = lane === 'p' ? quadSize : -quadSize;
      } else if (i === 13) {
        adj.start.y = lane === 'p' ? -quadSize : quadSize;
        adj.end.x = -quadSize;
      }

      const startX = c.x + adj.start.x;
      const startY = c.y + adj.start.y;
      const endX = c.x + adj.end.x;
      const endY = c.y + adj.end.y;

      const quad = `${letter} ${startX} ${startY} Q ${c.x} ${c.y} ${endX} ${endY}`;
      parts.push(quad);
    } else {
      parts.push(`${letter} ${c.x} ${c.y}`);
    }
  }

  return parts.join(' ');

}

function svgEl(elementName) {
  return document.createElementNS("http://www.w3.org/2000/svg", elementName);
}

function xy(x, y) {
  return x + ' ' + y;
}

function getPoints(x, y, size) {

  let offsetX = x * size;
  let offsetY = y * size;

  if (true) {
    const margin = 0;
    offsetX += margin;
    offsetY += margin;
    size -= margin + margin;
  }

  let quarter = size / 4;
  let half = size / 2;
  let point = size / 10;

  const points = [];

  // Top left.
  points.push(xy(offsetX, offsetY));

  // Top right.
  points.push(xy(offsetX + size, offsetY));

  // Bottom right.
  points.push(xy(offsetX + size, offsetY + size));

  // Bottom left.
  points.push(xy(offsetX, offsetY + size));

  return points;
}

function tToX(t, l) {
  if (t <= 4) {
    return 4 - t;
  } else if (t >= 13) {
    return (8 - (t - 12));
  } else {
    return t - 5;
  }
}

function tToY(t, l) {
  if (t <= 4 || t >= 13) {
    return l === 'p' ? 2 : 0;
  } else {
    return 1;
  }
}

function getTrackInfo() {

  const trackInfo = [];

  for (let t = 0; t <= 15; t++) {
    if (t <=4 || t >= 13) {
      trackInfo.push({
        t: t,
        x: tToX(t, 'p'),
        y: tToY(t, 'p'),
        l: 'player'
      });
      trackInfo.push({
        t: t,
        x: tToX(t, 'e'),
        y: tToY(t, 'e'),
        l: 'enemy'
      });
    } else {
      trackInfo.push({
        t: t,
        x: tToX(t),
        y: tToY(t),
        l: 'middle'
      });
    }
  }

  return trackInfo;
}

function generateSvgSquare(trackInfo) {

  const xPos = trackInfo.x * 100;
  const yPos = trackInfo.y * 100;

  const $svg = $(`<svg width="100" height="100" x="${xPos}" y="${yPos}">`);

  // Background of the cell.
  const checkerColor = (trackInfo.x + trackInfo.y) % 2 === 0 ? 'dark' : 'light';
  const backgroundColor = trackInfo.t > 0 && trackInfo.t < 15 ? checkerColor : 'empty';
  $(svgEl('rect')).attr({
    width: 100,
    height: 100
  }).addClass('background')
    .addClass(backgroundColor)
    .appendTo($svg);

  // Render a graphic for the special squares.
  if ([4, 8, 13].indexOf(trackInfo.t) >= 0) {
    $(svgEl('polygon')).attr({
      points: '50 76.0000014 39.6472382 88.6370331 36.9999993 72.5166617 21.7157288 78.2842712 27.4833383 63.0000007 11.3629669 60.3527618 23.9999986 50 11.3629669 39.6472382 27.4833383 36.9999993 21.7157288 21.7157288 36.9999993 27.4833383 39.6472382 11.3629669 50 23.9999986 60.3527618 11.3629669 63.0000007 27.4833383 78.2842712 21.7157288 72.5166617 36.9999993 88.6370331 39.6472382 76.0000014 50 88.6370331 60.3527618 72.5166617 63.0000007 78.2842712 78.2842712 63.0000007 72.5166617 60.3527618 88.6370331',
      fill: 'rgba(0, 0, 0, .1)'
    }).addClass('special')
      .appendTo($svg);
  }

  // Valid Move Emphasis.
  $(svgEl('circle')).attr({
    cx: 50,
    cy: 50,
    r: 25
  }).addClass('valid-move')
    .appendTo($svg);

  $(svgEl('rect')).attr({
    width: 100,
    height: 100
  }).addClass('valid-move')
    .appendTo($svg);

  // Tokens.
  $(svgEl('circle')).attr({
    cx: 50,
    cy: 50,
    r: 22
  }).addClass('token')
    .appendTo($svg);

  // Render the track number.
  // $(svgEl('text')).attr({
  //   x: 50,
  //   y: 50
  // }).text(trackInfo.t)
  //   .appendTo($svg);

  if (trackInfo.l !== 'enemy') {
    // We don't need events on the enemy side.
    $svg.on('click', function () {
      attemptMove(trackInfo.t, trackInfo.l);
    });
  }

  return $svg;
}

function Arrow(input) {

  // The original input used to generate the arrow.
  this.input = input;

  // An array of strings 'u', 'd', 'l', 'r' describing the path of the arrow.
  this.directions = null;

  // Used to keep track of where the arrow is moving to as we generate it.
  this.currentX = 0;
  this.currentY = 0;

  // The bounds are used to keep track of the biggest offset in each direction.
  this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  // The arrow positioning offset.
  this.offset = { x: 0, y: 0 };

  this.size = { width: 0, height: 0 };

  // An array containing details of each piece we need to render.
  this.arrowDetails = [];

  this.DIRECTION = {
    UP: 'u',
    DOWN: 'd',
    LEFT: 'l',
    RIGHT: 'r'
  };

  this.fromString(input);
  this.render();
}
Arrow.prototype.fromString = function (string) {
  this.directions = string.split('');

  const directionModifiers = {
    x: { l: -1, r: 1, u: 0, d: 0 },
    y: { l: 0, r: 0, u: -1, d: 1 }
  };

  // Travel through the arrow path keeping track of the position of each piece.
  // Also keep track of the bounds of the arrow, it'll be needed to determine the canvas size.
  for (let i = 0; i < this.directions.length; i++) {
    const direction = this.directions[i];

    this.arrowDetails.push({
      x: this.currentX,
      y: this.currentY,
      d: direction
    });

    this.currentX += directionModifiers.x[direction];
    this.currentY += directionModifiers.y[direction];

    if (direction === this.DIRECTION.UP) {
      this.bounds.minY = Math.min(this.currentY, this.bounds.minY);
    } else if (direction === this.DIRECTION.DOWN) {
      this.bounds.maxY = Math.max(this.currentY, this.bounds.maxY);
    } else if (direction === this.DIRECTION.LEFT) {
      this.bounds.minX = Math.min(this.currentX, this.bounds.minX);
    } else if (direction === this.DIRECTION.RIGHT) {
      this.bounds.maxX = Math.max(this.currentX, this.bounds.maxX);
    }
  }

  // Add an extra element onto the end for the rendering of the arrow head.
  const lastDirection = this.arrowDetails[this.arrowDetails.length - 1].d;
  this.arrowDetails.push({
    x: this.currentX,// += directionModifiers.x[lastDirection],
    y: this.currentY,// += directionModifiers.y[lastDirection],
    d: lastDirection
  });

  // Find the furthest negative X and Y positions, we'll need to move our arrow based on these values.
  this.offset = {
    x: this.arrowDetails.reduce((carry, current) => Math.min(current.x, carry), 0),
    y: this.arrowDetails.reduce((carry, current) => Math.min(current.y, carry), 0)
  };

  // Calculate the width and height needed to contain the arrow.
  this.size = {
    width: Math.abs(this.bounds.minX) + this.bounds.maxX + 1,
    height: Math.abs(this.bounds.minY) + this.bounds.maxY + 1
  };

  // Apply the calculated offset to each piece.
  for (let i = 0; i < this.arrowDetails.length; i++) {
    this.arrowDetails[i].x -= this.offset.x;
    this.arrowDetails[i].y -= this.offset.y;
  }

  this.pieceDetails.cap.svg = $svgArrowCap;
  this.pieceDetails.straight.svg = $svgArrowStraight;
  this.pieceDetails.corner.svg = $svgArrowCorner;
  this.pieceDetails.head.svg = $svgArrowHead;
};
Arrow.prototype.pieceDetails = {
  cap: {
    rotationMap: {
      l: 0, u: 1, r: 2, d: 3
    },
    svg: $svgArrowCorner
  },
  straight: {
    rotationMap: {
      l: 0, u: 1, r: 0, d: 1
    },
    svg: $svgArrowStraight
  },
  corner: {
    rotationMap: {
      // The corner rotation map includes the directions we are coming from and going in.
      // For example lu is from left going up.
      lu: 0, ld: 1,
      ur: 1, ul: 2,
      rd: 2, ru: 3,
      dr: 0, dl: 3
    },
    svg: $svgArrowCorner
  },
  head: {
    rotationMap: {
      l: 3, u: 0, r: 1, d: 2
    },
    svg: $svgArrowHead
  }
};
Arrow.prototype.trackDirections = {
  player: 'llllurrrrrrrdll',
  enemy: 'lllldrrrrrrrull'
};
Arrow.prototype.getArrowPath = function (t, moves, track) {
  return this.trackDirections[track].substr(t, moves);
};
Arrow.prototype.render = function () {
  const $svg = $('<svg version="1.1" xmlns="http://www.w3.org/2000/svg" class="arrow">').attr({
    width: this.size.width * 100,
    height: this.size.height * 100
  });

  for (let i = 0; i < this.arrowDetails.length; i++) {

    const thisDirection = this.arrowDetails[i].d;
    const lastDirection = (i === 0 ? thisDirection : this.arrowDetails[i - 1].d);

    let pieceType;

    if (i === 0) {
      // Cap piece.
      pieceType = 'cap';
    } else if (i === this.arrowDetails.length - 1) {
      // Arrow head.
      pieceType = 'head';
    } else if (thisDirection === lastDirection) {
      // Straight piece.
      pieceType = 'straight';
    } else {
      // Corner piece.
      pieceType = 'corner';
    }

    const partDetails = this.pieceDetails[pieceType];

    // Determine the required rotation for the piece.
    let rotationKey;
    if (pieceType === 'corner') {
      rotationKey = lastDirection + thisDirection;
    } else {
      rotationKey = thisDirection;
    }

    const rotation = (partDetails.rotationMap[rotationKey] || 0) * 90;

    // Apply the settings need to position the piece properly.
    const attributes = {
      position: {
        x: this.arrowDetails[i].x * 100,
        y: this.arrowDetails[i].y * 100
      },
      rotation: {
        transform: `rotate(${rotation} 50 50)`
      }
    };

    const $partClone = partDetails.svg.clone();
    $partClone.find('.part').attr(attributes.rotation);
    $partClone.attr(attributes.position).appendTo($svg);
  }

  this.svg = $svg;
};

function preRenderSvgArrowParts() {

  const $svgTemplate = $('<svg version="1.1">').attr({
    width: 100,
    height: 100,
    viewBox: '0 0 100 100'
  });

  // Render the arrow head.
  $svgArrowHead = $svgTemplate.clone().addClass('head');
  $(svgEl('path')).attr({
    d: 'M38,95 L26,95 L50,71 L74,95 L62,95 L62,100 L38,100 L38,95 Z'
  }).addClass('part')
    .appendTo($svgArrowHead);

  // Render the arrow corner.
  $svgArrowCorner = $svgTemplate.clone().addClass('corner');
  $(svgEl('path')).attr({
    d: 'M85,38 L100,38 L100,62 L85,62 C59.3697972,62 38.5312452,41.0480046 38.0099971,15 L38,15 L38,0 L62,0 L62,15 C62,27.7025492 71.8497355,38 84,38 C84.3351364,38 84.6685225,37.9921657 85,37.9766627 L85,38 Z'
  }).addClass('part')
    .appendTo($svgArrowCorner);

  // Render the arrow straight.
  $svgArrowStraight = $svgTemplate.clone().addClass('straight');
  $(svgEl('rect')).attr({
    x: 0,
    y: 38,
    width: 100,
    height: 24
  }).addClass('part')
    .appendTo($svgArrowStraight);

  // Render the arrow cap.
  $svgArrowCap = $svgTemplate.clone().addClass('cap');
  $(svgEl('rect')).attr({
    x: 0,
    y: 38,
    width: 50,
    height: 24
  }).addClass('part')
    .appendTo($svgArrowCap);

}

function attemptMove(trackId, laneName) {
  if (!currentGame || !currentGame.isValidMove(trackId, laneName)) {
    return;
  }

  console.log(`${laneName}:${trackId} looks good to the client`);
  socket.emit('game-move', {
    gameId: currentGame.id,
    track: trackId,
    lane: laneName
  });
}

function moveToken(gameId, pid, t, m) {
  return new Promise((resolve, reject) => {
    console.log('moveToken', {gameId:gameId,pid:pid,t:t,m:m});
    // Verify that the game we're moving a token for is still the game we have open.
    if (gameId !== currentGame.id) {
      reject();
      return;
    }

    const lane = pid === myPlayerId ? 'p' : 'e';
    const laneFull = pid === myPlayerId ? 'player' : 'enemy';
    const otherLane = pid === myPlayerId ? 'enemy' : 'player';
    const d = t + m;

    // Remove the original token, we can't have it in place during the animation.
    $svgBoard.find('svg.cell.t-' + t + '.l-' + laneFull).removeClass(laneFull);

    // Animate the token.
    animateToken(t, m, lane)
      .then(() => {
        // Ensure the same game is still open before placing the token down.
        // If the user swapped games we don't want interference.
        if (gameId !== currentGame.id) {
          return;
        }

        // Only place a new token if we aren't going to the 15th spot.
        if (d < 15) {
          // Place the new token.
          $svgBoard.find('svg.cell.t-' + d + '.l-' + laneFull)
            .addClass(laneFull)
            // Make sure that were we landed there isn't another token.
            .removeClass(otherLane);
        }
        resolve();
      });
    });
}

window.animationTest = function (trackIndex, movementPoints, laneName) {

  const pathCoordinates = getPathCoords(trackIndex, movementPoints, laneName);
  const initial = pathCoordinates[0];

  const moveTime = 1000;
  const animTime = 900;

  let $token = $('circle.token.ani-token');
  if (!$token.length) {
    $token = $(svgEl('circle')).attr({
      cx: 0,
      cy: 0,
      r: 22
    }).addClass('token')
      .addClass('ani-token');
  }

  console.log('settin to', initial.x, initial.y);

  $token
    // Position the token in the right place to start the animation.
    .css('transform', `translate(${initial.x}px, ${initial.y}px)`)
    // Apply transitions to the transform property to animate it.
    .css('transition', `transform ${animTime}ms ease`)
    .appendTo($svgBoard)
  ;

  for (let i = 1; i < pathCoordinates.length; i++) {
    const current = pathCoordinates[i];
    const previous = pathCoordinates[i - 1];

    const sleepDelay = (i - 1) * moveTime;
    const sleepGlobalDelay = 10;
    const sleepInsert = i * 10;
    const sleepTotal = sleepGlobalDelay + sleepDelay + sleepInsert;

    setTimeout(() => {
      console.log('moving to', current.x, current.y);
      // Disable transforms and snap us straight to the next starting point
      // (we should already be there pixel perfect), this hack works around
      // FireFox not doing animations properly on the first run.
      $token
        // .css({cx: c.x, cy: c.y})
        // .css('transform', noTransform)
        .css('transform', `translate(${previous.x}px, ${previous.y}px)`)
        // Move towards the next point.
        // .css('transform', useTransform)
        .css('transform', `translate(${current.x}px, ${current.y}px)`);
    }, sleepTotal);
  }

};

function getPathCoords(track, moves, lane) {

  const coordinates = {
    p: [
      '450 250', '350 250', '250 250', '150 250', '50 250',
      '50 150', '150 150', '250 150', '350 150', '450 150', '550 150', '650 150', '750 150',
      '750 250', '650 250', '550 250'
    ],
    e: [
      '450 50', '350 50', '250 50', '150 50', '50 50',
      '50 150', '150 150', '250 150', '350 150', '450 150', '550 150', '650 150', '750 150',
      '750 50', '650 50', '550 50'
    ]
  };

  const parts = [];
  const last = parseInt(track) + parseInt(moves);

  for (let i = track; i <= last; i++) {
    const coordinatePair = coordinates[lane][i].split(' ');
    const c = {
      x: parseInt(coordinatePair[0]),
      y: parseInt(coordinatePair[1])
    };
    parts.push(c);
  }

  return parts;

}
