var Game = function (pid1, pid2) {
    this.player1 = new Player(pid1, 1);
    this.player2 = new Player(pid2, 2);
    this.currentPlayer = null;
    this.currentRoll = null;
    this.id = null;
    this.turn = 0;
    this.rollDice = function () {
        // The number of movement points are decided by 4 coin flips.
        var dieValue = 0;
        for (var i in [1, 2, 3, 4]) {
            dieValue += getRandomBoolean();
        }
        return dieValue;
    };

    this.getTrack = function () {
        var track = {};
        for (var i = 0; i <= 15; i++) {
            track[i] = 0;
        }
        return track;
    };

    /**
     * The track is an object that is keyed by the position between start (0) and end (15)
     * whose values store the existence for each player within them (bitwise flags).
     * If the value is 1 then that means player 1 is there only.
     * If the value is 2 then that means player 2 is there only.
     * If the value is 3 then that means player 1 and 2 are there.
     * We need this because the track stores your position between start and end but doesn't
     * have any other way to specify what cells are shared between both players.
     */
    this.track = this.getTrack();

    this.isValidMove = function (track, lane) {
        return this.attemptMove(track, lane);
    };

    this.attemptMove = function (track, lane) {

        if (lane !== 'player' && lane !== 'middle') {
            // Can only handle moves that are in the middle or player lanes.
            return false;
        }

        var validMoves = this.getValidMoves();

        return validMoves[track];

    };

    this.getValidMoves = function () {

        if (this.currentRoll === null) {
            // A move cannot be made until we know the move count.
            return;
        }

        var moves = {};

        // First we need to know what valid moves there are for
        // the current player.
        var player = this.getCurrentPlayer();
        var enemy = this.getEnemyPlayer();

        // Look along the track to see if there are any tokens
        // that can be moved with the current roll.
        for (var i = 0; i <= 14; i++) {
            // Search the track for tokens.

            // By default we can't move; we will change this
            // value if we can move later.
            moves[i] = false;

            // If its the start cell then it is only valid if we have tokens
            // and all the rules below apply.
            if (i === 0 && player.tokensWaiting === 0) {
                continue;
            }

            // Can't move from here if we don't have a token on this spot.
            // Doesn't apply to start tiles as they never actually have tokens.
            if ((this.track[i] & player.number) !== player.number && i !== 0) {
                continue;
            }

            // A token for this player was found - figure
            // out if it can be moved.

            var destination = i + this.currentRoll;

            // Cannot move onto your own token.
            if ((this.track[destination] & player.number) === player.number) {
                continue;
            }

            // There is a token on the protected cell.
            if (destination === 8 && this.track[destination] > 0) {
                continue;
            }

            // We're near the end but don't have the exact roll to
            // remove our token from the board.
            if (destination > 15) {
                continue;
            }

            // We can make this move.
            moves[i] = true;
        }

        return moves;
    };

    /**
     * Get the current player's player object.
     *
     * @returns {Player} The player object for the current player.
     */
    this.getCurrentPlayer = function () {
        if (this.currentPlayer === this.player1.pid) {
            return this.player1;
        } else if (this.currentPlayer === this.player2.pid) {
            return this.player2;
        } else {
            return null;
        }
    };

    /**
     * Get the enemy player's player object.
     *
     * @returns {Player} The player object for the enemy player.
     */
    this.getEnemyPlayer = function () {
        if (this.currentPlayer === this.player1.pid) {
            return this.player2;
        } else if (this.currentPlayer === this.player2.pid) {
            return this.player1;
        } else {
            return null;
        }
    };

    /**
     * Get the player object for the provided player pid.
     *
     * @param {int} pid The player id of the player we want the player object for.
     * @returns {Player} The player object for the provided player id.
     */
    this.getPlayerById = function (pid) {
        // console.log('Getting player by ID', pid, this.player1.pid, this.player2.pid);
        if (this.player1.pid === pid) {
            return this.player1;
        } else if (this.player2.pid === pid) {
            return this.player2;
        } else {
            return null;
        }
    };

    /**
     * Get the player object for the player number provided.
     *
     * @param {int} number The number of the player to get the player object for.
     * @returns {Player} The player object for the provided player number.
     */
    this.getPlayerByNumber = function (number) {
        if (number === 1) {
            return this.player1;
        } else if (number === 2) {
            return this.player2;
        } else {
            return null;
        }
    };
};
var Player = function (pid, playerNumber) {
    this.number = playerNumber;
    this.pid = pid;
    this.tokensWaiting = 7;
    this.tokensDone = 0;
};
function getRandomBoolean() {
    return Math.random() >= 0.5;
}
