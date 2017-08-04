'use strict';
const debug = require('debug')('correlations-game:routes:voice');
const express = require('express');
const router = express.Router();
const games = (process.env.GAME === 'LONGER') ? require('../bin/lib/gameLonger') : require('../bin/lib/game');
const responses = require('../responses/content');
const { ApiAiApp } = require('actions-on-google');

process.env.DEBUG = 'actions-on-google:*';

const Actions = {
  INIT: 		'correlations.welcome',
  QUESTION: 	'correlations.question',
  ANSWER:   	'correlations.answer',
  NOTHEARD:  	'correlations.misunderstood'
};

const Contexts = {
	GAME: 	'Game',
	MISUNDERSTOOD: 'Misunderstood'
};

const optionsSynonyms = [
	[
		'1',
		'one',
		'won',
		'huan',
		'juan'
	],

	[
		'2',
		'two',
		'to',
		'too'
	],

	[
		'3',
		'three'
	]
]

if (!Object.values) {
  Object.values = o => Object.keys(o).map(k => o[k]);
}

const returnQuestion = app => {
	app.setContext(Contexts.GAME, 1000);
	getQuestion(app.body_.sessionId, obj => {
		app.ask(obj.ssml);
	});
};

const matchAnswer = app => {
	let USER_INPUT = app.body_.result.resolvedQuery;
	const SESSION = app.body_.sessionId;

	getExpectedAnswers(SESSION)
	.then(answers => {
		const expectedAnswers = Object.keys(answers).map(key => {
			return answers[key].replace('people:', '').replace('.', '').replace('-', ' ').toLowerCase();
		});

		if (checkString(USER_INPUT.toLowerCase(), 0)) {
			USER_INPUT = expectedAnswers[0];
		} else if (checkString(USER_INPUT.toLowerCase(), 1)) {
			USER_INPUT = expectedAnswers[1];
		} else if (checkString(USER_INPUT.toLowerCase(), 2)) {
			USER_INPUT = expectedAnswers[2];
		}

		if (
			USER_INPUT.toLowerCase() === expectedAnswers[0] ||
			USER_INPUT.toLowerCase() === expectedAnswers[1] ||
			USER_INPUT.toLowerCase() === expectedAnswers[2]
		) {
			checkAnswer(SESSION, 'people:' + USER_INPUT, obj => {
    			app.setContext(Contexts.GAME, 1000);
				app.ask(obj.ssml);
			});
		} else {
			if(app.getContext(Contexts.MISUNDERSTOOD.toLowerCase()) === null && expectedAnswers.length > 0) {
				app.setContext(Contexts.MISUNDERSTOOD, 3);
				return app.ask(responses.misunderstood(true, USER_INPUT, expectedAnswers).ssml);
			}

			if(app.getContext(Contexts.MISUNDERSTOOD.toLowerCase()).lifespan === 0 || expectedAnswers.length === 0) {
				if(expectedAnswers.length === 0) {
					app.setContext(Contexts.MISUNDERSTOOD, 1);
				}
				return app.ask(responses.misunderstood(false).ssml);
			}

			app.ask(responses.misunderstood(true, USER_INPUT, expectedAnswers).ssml);
		}
	});
};

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
			callback(responses.win());
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

			callback(responses.askQuestion(preparedData));
		}
	})
	.catch(err => {
		debug(`ERROR: getQuestion: err=${err}`);
	})
	;
}

function getExpectedAnswers(session) {
	return games.check(session)
	.then(gameIsInProgress => {
		if(gameIsInProgress) {
			return games.get(session).then(data => data.answersReturned);
		} else {
			return [];
		}
	});
}

function checkAnswer(session, answer, callback) {
	games.answer(session, answer)
		.then(result => {
			if(result.correct === true){
				getQuestion(session, obj => {
					callback(responses.correctAnswer(result.linkingArticles[0].title, obj));
				});
			} else {
				callback(responses.incorrectAnswer(result.expected, result.linkingArticles[0].title));
			}
		})
	;
}

function checkString(input, option) {
	for(let i = 0; i < optionsSynonyms[option].length; ++i) {
		if(input.startsWith(optionsSynonyms[option][i])) {
			return true;
		}
	}

	return false;
}

const actionMap = new Map();
actionMap.set(Actions.QUESTION, returnQuestion);
actionMap.set(Actions.ANSWER, matchAnswer);
actionMap.set(Actions.NOTHEARD, matchAnswer);

router.post('/googlehome', (request, response) => {
  const app = new ApiAiApp({ request, response });
  app.handleRequest(actionMap);
});

module.exports = router;
