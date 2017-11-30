'use strict';
const correlations_service = require('../../bin/lib/correlations');
const fs = require('fs');
const striptags = require('striptags');
const path = require('path');

function getCorrectAnswer(personX, people) {
    return correlations_service.calcChainLengthsFrom(`people:${personX}`)
        .then(result => {
            let directConnections;
            for (let r of result) {
                if (r.links === 1) directConnections = r.entities;
            }
            directConnections = directConnections.map(p => p.replace('people:', ''));
            for (const p of people) {
                if (directConnections.includes(p)) return p;
            }
        });
}

function getIncorrectAnswer(personX, people) {
    return getCorrectAnswer(personX, people)
        .then(correctAnswer => {
            const index = people.indexOf(correctAnswer);
            people.splice(index, 1);
            return people[0];
        });
}

function getPeopleFromQuestion(question) {
    const reX = /Question [0-9]+\. (.*?) was mentioned/;
    const resultX = reX.exec(question);

    const reOne = /one\) (.*?)\./;
    const resultOne = reOne.exec(question);

    const reTwo = /two\) (.*?)\./;
    const resultTwo = reTwo.exec(question);

    const reThree = /three\) (.*?)\./;
    const resultThree = reThree.exec(question);
    
    return {
        personX: resultX[1],
        people: [
            resultOne[1],
            resultTwo[1],
            resultThree[1]
        ]
    };
}

function sendRequest(event, handler) {
    return new Promise((resolve, reject) => {
        handler(event, {
            succeed: resolve,
            fail: reject
        });
    });
}

function processSpeech(speech) {
    speech = striptags(speech);
    speech = speech.trim();
    return speech;
}

function getInteractionModelFromJSON(filename) {
    return new Promise(function(resolve, reject) {
        fs.readFile(path.join(process.cwd(), filename), 'utf-8', function(err, data){
            if (err) {
                reject(err); 
            } else {
                resolve(data);
            }
        });
    });
};

function buildRequest(info, session, attributes, request) {
    const newRequest = {
        session: {
            attributes: attributes,
            sessionId: session.sessionId,
            application: {
                applicationId: info.applicationId,
            },
            user: {
                userId: info.userId,
            },
            new: info.newSession
        }, 
        request: {
            type: request.type,
            locale: info.locale,
            requestId: info.requestId,
            timestamp: + new Date()
        }
    };

    if (request.type === 'IntentRequest') {        
        newRequest.request.type = 'IntentRequest';
        newRequest.request.intent = {
            name: request.name
        }
        if (request.slots) {
            newRequest.request.intent.slots = request.slots;
        }
    }

    return newRequest;
}

module.exports = {
    getCorrectAnswer,
    getIncorrectAnswer,
    getPeopleFromQuestion,
    sendRequest,
    getInteractionModelFromJSON,
    processSpeech,
    buildRequest
}
