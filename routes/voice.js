const debug = require('debug')('correlations-game:routes:voice');
const express = require('express');
const router = express.Router();

const games = require('../bin/lib/game');
const activeSessions = {};
let expectedAnswers = [];
const not_understood_limit = 3;
let not_understood_count = 0;

router.post('/googlehome', (req, res) => {
	const USER_INPUT = req.body.result.resolvedQuery;
	const SESSION = req.body.sessionId;
	let answer;
	
	// activeSessions[SESSION]['count'] = 0;
	setCountState(SESSION, null);

	console.log('TEST', getCountState(SESSION));


	res.setHeader('Content-Type', 'application/json');

	switch(USER_INPUT.toLowerCase()) {
		case 'start':
		case 'repeat':
			not_understood_count = 0;
			return getQuestion(SESSION, ans => {
				res.json({'speech': ans, 'displayText': ans});
			});
		break;

		case 'help':
			not_understood_count = 0;
			answer = "Add instructions here";
			//?TODO: handle in a different intent?
		break;

		case expectedAnswers[0]:
		case expectedAnswers[1]:
		case expectedAnswers[2]:
			not_understood_count = 0;
			return checkAnswer(SESSION, 'people:' + USER_INPUT, ans => {
				res.json({'speech': ans, 'displayText': ans});
			});
		break;

		default:
			if(not_understood_count < not_understood_limit && expectedAnswers.length > 0) {
				answer = 'Sorry, I heard '+ USER_INPUT +'. The possible answers were:';

				for(let i = 0; i < expectedAnswers.length; ++i) {
					answer += '- ' + expectedAnswers[i];
				}

				++not_understood_count;
			} else {
				answer = 'Sorry, I\'m not quite sure what you mean. Say "help" for instructions.';
			}
	}

	res.json({'speech': answer, 'displayText': answer});

});

function getQuestion(session, callback) {
	games.check(session)
	.then(gameIsInProgress => {
		if(gameIsInProgress){
			return games.question(session);
		} else {
			return games.new(session)
				.then(gameUUID => {
					return gameUUID;
				})
				.then(gameUUID => games.question(gameUUID))
			;
		}
	})
	.then(data => {
		if(data.limitReached === true){
			callback('winner');
		} else {
			const preparedData = {};

			preparedData.seed = {
				value : data.seed,
				printValue : data.seed.replace('people:', '').replace('.', '').replace('-', ' ')
			};

			preparedData.options = {};

			Object.keys(data.options).forEach(key => {
				preparedData.options[key] = {
					value : data.options[key],
					printValue : data.options[key].replace('people:', '').replace('.', '').replace('-', ' ')
				};
			});

			formatQuestion(preparedData, ans => {
				callback(ans);
			});
		}
	});
}

function checkAnswer(session, answer, callback) {
	games.answer(session, answer)
	.then(result => {
		if(result.correct === true){
			getQuestion(session, ans => {
				callback('Correct. ' + ans);
			});
		} else {
			expectedAnswers = [];
			callback('Sorry, that is incorrect. The correct answer was ' + result.expected);
		}
	});
}

function formatQuestion(options, callback) {
	let answerFormat = 'Who was recently mentioned in an article with ' + options.seed.printValue + '?\n';
	expectedAnswers = [];
	Object.keys(options.options).forEach(key => {
		answerFormat += ' - ' + options.options[key].printValue;
		expectedAnswers.push(options.options[key].printValue.toLowerCase());
	});

	callback(answerFormat);
}

function getCountState(sessionID){
	return Promise.resolve( Object.assign({}, activeSessions[sessionID]) );
}

function setCountState(sessionID, count) {
	return new Promise( (resolve) => {
		const activeSession = activeSessions[sessionID]
		if( activeSession === undefined || activeSession.count === undefined){
			activeSessions[sessionID]['count'] = 0;
		} else {
			activeSession.count = (count === null)?activeSession.count:count;
		}

		resolve({
			count : activeSessions[sessionID]['count']
		});

	});
}

module.exports = router;