const _ = require('lodash');
const moment = require('moment');

const {httpRequest} = require('../util/httpUtil');
const {login} = require('../service/loginService');

let headers = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "accept-language": "zh-CN,zh-TW;q=0.9,zh;q=0.8",
    "cache-control": "max-age=0",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1"
};

async function getQuestionByIds(questionIds) {
    let questions = await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/questions?ids=${questionIds.join(',')}`,
        method: "GET",
        json: true,
        headers
    });
    return _.zipObject(questions.map(q => q.id), questions)
}

async function getQuestionMetaByIds(questionIds) {
    let questions = await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/question/meta?ids=${questionIds.join(',')}`,
        method: "GET",
        json: true,
        headers
    });
    return _.zipObject(questions.map(q => q.id), questions)
}

async function getQuestionKeyPointsByIds(questionIds) {
    let questions = await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/solution/keypoints?ids=${questionIds.join(',')}`,
        method: "GET",
        json: true,
        headers
    });
    return _.zipObject(questionIds, questions);
}

// 返回收藏了的题目的id数组
async function getCollectsByIds(questionIds, cookie) {
    return await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/collects?ids=${questionIds.join(',')}`,
        method: "GET",
        json: true,
        headers: {
            ...headers,
            cookie
        }
    });
}

function getExerciseReport(exerciseId, cookie) {
    return httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/exercises/${exerciseId}/report/v2`,
        method: "GET",
        json: true,
        headers: {
            ...headers,
            cookie
        }
    });
}

function getExercise(exerciseId, cookie) {
    return httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/exercises/${exerciseId}`,
        method: "GET",
        json: true,
        headers: {
            ...headers,
            cookie
        }
    });
}

async function getExerciseHistory(categoryId, cookie) {
    let cursorArr = [0, 30];
    let hisArr = await Promise.all(cursorArr.map(cursor => {
        return httpRequest({
            url: `https://tiku.fenbi.com/api/xingce/category-exercises?categoryId=${categoryId}&cursor=${cursor}&count=30`,
            method: "GET",
            json: true,
            headers: {
                ...headers,
                cookie
            }
        });
    }));
    return _.flatMap(hisArr, his => his.datas);
}

async function getSolutionsByIds(questionIds, cookie) {
    let questions = await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/solutions?ids=${questionIds.join(',')}`,
        method: "GET",
        json: true,
        headers: {
            ...headers,
            cookie
        }
    });
    return _.zipObject(questionIds, questions);
}

async function getVideoIdByIds(questionIds, cookie) {
    let result = await httpRequest({
        url: `https://ke.fenbi.com/api/gwy/v3/episodes/tiku_episodes_with_multi_type?tiku_ids=${questionIds.join(',')}&tiku_prefix=xingce&tiku_type=5`,
        method: "GET",
        json: true,
        headers: {
            ...headers,
            cookie
        }
    });
    return result.data;
}

exports.getExerciseHistory = async function (cookie) {
    let result = await Promise.all([
        getExerciseHistory(1, cookie),
        getExerciseHistory(3, cookie)
    ]);
    let exerciseHistory = _.orderBy(_.flatMap(result, _.identity), ['updatedTime'], ['desc']);
    let exerciseReportMap = _.zipObject(exerciseHistory.map(item => item.id), await Promise.all(exerciseHistory.map(item => getExerciseReport(item.id, cookie))));
    exerciseHistory.forEach(history => {
        history.finishedTime = moment(history.updatedTime).format('YYYY-MM-DD HH:mm:ss')
        let report = exerciseReportMap[history.id];
        if (report) {
            history.elapsedTime = report.elapsedTime;
            history.answerCount = report.answerCount;
            history.correctRate = (report.correctCount / report.answerCount * 100).toFixed(1);
        }
    });
    exerciseHistory = exerciseHistory.filter(h => h.status === 1 && h.answerCount > 0);

    return {
        exerciseHistory: exerciseHistory.filter(h => h.status === 1),
        moment
    }
}

exports.getResultObj = async function (exerciseId, costThreshold, cookie) {
    let [exercise, report] = await Promise.all([getExercise(exerciseId, cookie), getExerciseReport(exerciseId, cookie)]);

    let collectionIds = await getCollectsByIds(report.answers.map(answer => answer.questionId), cookie);

    let answerResultMap = {};

    report.answers.forEach(answer => {
        // 只筛选出你做了的
        if (answer.status !== 10 || collectionIds.includes(answer.questionId)) {
            answerResultMap[answer.questionId] = answer.correct;
        }
    });

    let concernQuestions = Object.keys(answerResultMap).map(questionId => {
        let ua = Object.values(exercise.userAnswers).find(item => item.questionId == questionId);
        let correct = answerResultMap[questionId];
        return {
            idx: (ua && ua.questionIndex) || report.answers.findIndex(item => item.questionId == questionId) + 1,
            questionId,
            correct,
            cost: ua && ua.time
        }
    }).filter(a => a);

    // let questionContentMap = await getQuestionByIds(concernQuestions.map(q => q.questionId));
    // let questionMetaMap = await getQuestionMetaByIds(concernQuestions.map(q => q.questionId));
    // let questionKeyPointsMap = await getQuestionKeyPointsByIds(concernQuestions.map(q => q.questionId));
    let solutionMap = await getSolutionsByIds(concernQuestions.map(q => q.questionId), cookie);

    concernQuestions = _.orderBy(concernQuestions, ['correct', 'cost', 'idx'], ['asc', 'desc', 'asc']);

    let concernSource = ['国家', '联考', '省', '市'];
    let concernSourceCountMap = {};
    concernQuestions.forEach(q => {
        let solutionObj = solutionMap[q.questionId];
        // 题干
        q.content = solutionObj.content; // html
        // 选项
        q.options = solutionObj.accessories[0].options;
        // 难度
        q.difficulty = solutionObj.difficulty;
        // 正确答案
        q.correctAnswer = solutionObj.correctAnswer;
        // 题目来源
        q.source = solutionObj.source;

        concernSource.some(item => {
            if (q.source.includes(item)) {
                concernSourceCountMap[item] = (concernSourceCountMap[item] || 0) + 1;
                return true;
            }
            return false;
        });

        q.hasCollect = collectionIds.some(qid => qid == q.questionId);

        q.keypoints = solutionObj.keypoints.map(i => i.name);
        q.tags = solutionObj.tags.map(i => i.name);

        // 答案解析
        q.solution = solutionObj.solution; // html

        q.mostWrongAnswer = solutionObj.questionMeta.mostWrongAnswer;

        q.correctRatio = solutionObj.questionMeta.correctRatio;

        if (solutionObj.note) {
            q.note = solutionObj.note.content;
        }

        // q.userAnswer = solutionObj.userAnswer;
    });
    return {
        moment,
        exercise,
        costThreshold,
        concernSourceCount: Object.keys(concernSourceCountMap).map(key => ({key, count: concernSourceCountMap[key]})),
        concernQuestions
    }
}

exports.addCollect = async function (questionId, cookie) {
    return await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/collects/${questionId}`,
        method: "POST",
        headers: {
            ...headers,
            cookie
        },
        body: null
    });
}

exports.delCollect = async function (questionId, cookie) {
    await httpRequest({
        url: `https://tiku.fenbi.com/api/xingce/collects/${questionId}`,
        method: "DELETE",
        headers: {
            ...headers,
            cookie
        }
    });
}

exports.getVideoUrl = async function (questionId, cookie) {
    let videoMap = await getVideoIdByIds([questionId]);
    if (videoMap[questionId]) {
        let videoResult = await httpRequest({
            url: `https://ke.fenbi.com/api/gwy/v3/episodes/${videoMap[questionId][0].id}/mediafile/meta`,
            method: "GET",
            headers: {
                ...headers,
                cookie
            },
            json: true
        });
        if (videoResult && videoResult.datas && videoResult.datas.length > 0) {
            return _.orderBy(videoResult.datas, ['realSize'], ['desc'])[0].url;
        } else {
            return null;
        }
    } else {
        return null;
    }
}
