require('jquery/src/jquery');
require('./scss/ur.scss');
const Game = require('./js/Game');
const io = require('socket.io-client');

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
      console.log('auth.required');
      $('#authentication_overlay').css('display', 'flex');
    },
    login: {
      /**
       * Received when we have logged in successfully.
       * @param {{id: number, name: string, rememberToken: ?string}} payload
       */
      success: function (payload) {
        console.log(`auth.login.success ${payload.name} (${payload.id})`);

        // Clear the login form.
        $('.login-box form').trigger('reset');

        myPlayerId = payload.id;
        if (payload.rememberToken) {
          // Save the rememberToken for future use.
          localStorage.setItem('remember-token', payload.rememberToken);
        }
        if (localStorage.getItem('local-chat-' + myPlayerId)) {
          chatLog = JSON.parse(localStorage.getItem('local-chat-' + myPlayerId));
          console.log('loaded chatLog', chatLog);
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
        console.log('auth.login.failure', failureReason);
        showMessageBox('Authentication Failed', failureReason);
      }
    },
    register: {
      /**
       * Registration succeeded.
       * @param {{id: number, name: string}} newUser
       */
      success: function (newUser) {
        console.log('auth.register.success', newUser);

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
        console.log('auth.register.failure', failureReason);
        showMessageBox('Registration Failed', failureReason);
      }
    },
    /**
     * Sent when the user has requested to be logged out.
     */
    logout: () => {
      console.log('auth.logout');
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
        console.log('auth.lobby.players.set', connectedUsers);
        lobbyPlayerList = connectedUsers;
        renderPlayerList();
      },
      /**
       * Server has told us that a player has joined the lobby.
       * @param {{id: number, name: string}} newPlayer
       */
      join: function (newPlayer) {
        console.log('auth.lobby.players.join', newPlayer);
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
        console.log('auth.lobby.players.left', player);
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
        console.log('lobby.challenge.new', newChallenge);
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
        console.log('lobby.challenge.set', challenges);
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
        console.log('lobby.games.set', gameList);
        lobbyGameList = gameList;
        renderLobbyGameList();
      },
      /**
       * Sent when the player has been added to a new game.
       * @param {lobbyGameListItem} gameDetails
       */
      add: function (gameDetails) {
        console.log('lobby.games.add', gameDetails);
        lobbyGameList.push(gameDetails);
        renderLobbyGameList();
      },
      /**
       * Sent when the player has finished with a game.
       * @param {lobbyGameListItem} gameDetails
       */
      remove: function (gameDetails) {
        console.log('lobby.games.remove', gameDetails);
        for (let i = 0; i < lobbyGameList.length; i++) {
          if (lobbyGameList[i].gameId === gameDetails.gameId) {
            lobbyGameList.splice(i, 1);
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
        console.log('lobby.games.exist', otherPlayer);
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
      console.log('game.set', gameData);
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
     * @param {Game} gameData
     */
    activity: function (gameData) {
      console.log('game.activity', gameData);

      const game = new Game(0, 0);
      game.hydrate(gameData);

      if (currentGame !== null && currentGame.id === gameData.id) {
        currentGame = game;
        renderGameBoard();
        renderTitle();
      } else {
        console.log('got activity for a game we\'re not looking at; updating sidebar only');
        // Update the sidebar with the new information.
        for (let i = 0; i < lobbyGameList.length; i++) {
          // Search for the existing game item.
          if (lobbyGameList[i].gameId === gameData.id) {
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
socket.on('game-remove', events.game.remove);

// Social
socket.on('chat-add', events.chat.add);
socket.on('chat-update', events.chat.update);

let $boardTemplate;

$(() => {
  const originalBoardTemplate = '.board-container .board';

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

  console.log('checking for your games', lobbyGameList, myPlayerId);

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

  console.log('renderTitle', title);
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

  const player1 = currentGame.player1;
  const player2 = currentGame.player2;

  const player = currentGame.getPlayerById(myPlayerId);
  const enemy = currentGame.getPlayerById(myPlayerId === player1.pid ? player2.pid : player1.pid);

  const $newBoard = $boardTemplate.clone();

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

  // Update token positions on the board.
  for (let i = 1; i <= 14; i++) {
    const trackValue = currentGame.track[i];

    if (trackValue === 0) {
      // No tokens on this cell.
      continue;
    }

    if ((trackValue & player.number) === player.number) {
      const $targetCell = $newBoard.find(cellSelector(i, 'player'));
      const $playerToken = $('<div class="token player">');
      $targetCell.append($playerToken);
    }

    if ((trackValue & enemy.number) === enemy.number) {
      const $targetCell = $newBoard.find(cellSelector(i, 'enemy'));
      const $enemyToken = $('<div class="token enemy">');
      $targetCell.append($enemyToken);
    }
  }

  // Mark the valid moves on the board for the current player if they rolled already.
  if (currentGame.currentPlayer === player.pid && currentGame.currentRoll) {
    const validMoves = currentGame.getValidMoves();

    for (let i = 0; i <= 14; i++) {
      if (validMoves[i] === true) {
        console.log(i, 'is a valid move');
        $newBoard.find(cellSelector(i, 'player')).addClass('valid');
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

  // Add the event to handle selecting the valid moves.
  $newBoard.on('click', '.cell.valid', function () {
    const trackId = $(this).data('track');
    const laneName = $(this).data('lane');
    if (currentGame.isValidMove(trackId, laneName)) {
      // Send this move to the server, it'll be validated, so we don't need to
      // care that much about players messing with their client.
      // If the move isn't valid, we'll force them to reload the game state.
      console.log(`${laneName}:${trackId} looks good to the client`);
      socket.emit('game-move', {
        gameId: currentGame.id,
        track: trackId,
        lane: laneName
      });
    }
  });

  // Replace the game board with the new one.
  const $boardContainer = $('.board-container');
  $boardContainer.find('.board').remove();
  $boardContainer.append($newBoard);

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

  // Ensure the dice box has the right events if they're needed.
  if (!currentGame.currentRoll) {
    $rollBox.off('click').on('click', () => {
      console.log('sending dice roll');
      socket.emit('game-roll', currentGame.id);
    });
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
}

function cellSelector(trackIndex, laneName) {
  if (trackIndex >= 5 && trackIndex <= 12) {
    laneName = 'middle';
  }
  return `.cell[data-lane="${laneName}"][data-track="${trackIndex}"]`;
}

function openPlayerMenu () {
  const playerId = $(this).data('userId');
  const playerName = $(this).data('userName');

  // Build the dialog.
  const $overlay = $('<div class="overlay player-menu-overlay">');
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
  $overlay.append($playerMenu);

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

  $overlay.append($messageBox);
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