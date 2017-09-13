module.exports = Player;

/**
 * The Player object is used to track state about each of the players in the game.
 *
 * @param {string} pid The id of the player.
 * @param {int} playerNumber The number of the player.
 * @constructor
 */
function Player(pid, playerNumber) {

    /**
     * This player's number (either 1 for player 1 or 2 for player 2).
     *
     * @type {int} 1 or 2 for player 1 or 2.
     */
    this.number = playerNumber;

    /**
     * This player's id.
     *
     * @type {string} The id of the player.
     */
    this.pid = pid;

    /**
     * The number of tokes that are waiting to enter play.
     *
     * @type {number} The number of tokens to be played.
     */
    this.tokensWaiting = 7;

    /**
     * The number of tokens that have passed around the board.
     *
     * @type {number} The number of tokens that have reached the end.
     */
    this.tokensDone = 0;
};
