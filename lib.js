const FS        = require("fs");
const Path      = require("path");
const Walker    = require("walk");
const jwt       = require("jsonwebtoken");
const moment    = require("moment");
const config    = require("./config");
const base64url = require("base64-url");

const RE_GT    = />/g;
const RE_LT    = /</g;
const RE_AMP   = /&/g;
const RE_QUOT  = /"/g;
const RE_FALSE = /^(0|no|false|off|null|undefined|NaN|)$/i;


function bool(x) {
    return !RE_FALSE.test(String(x).trim());
}

function htmlEncode(html) {
    return String(html)
        .trim()
        .replace(RE_AMP , "&amp;")
        .replace(RE_LT  , "&lt;")
        .replace(RE_GT  , "&gt;")
        .replace(RE_QUOT, "&quot;");
}

/**
 * This will parse and return the JSON contained within a base64-encoded string
 * @param {String} inputString Base64url-encoded string
 * @returns {Object}
 */
function decodeArgs(inputString) {
    let args;
    try {
        args = JSON.parse(base64url.decode(inputString));
    }
    catch(ex) {
        args = null;
    }
    finally {
        if (!args || typeof args !== "object") {
            args = {};
        }
    }
    return args;
}

/**
 * This will parse and return the JSON contained within a base64-encoded route
 * fragment. Given a request object and a paramName, this function will look for
 * route parameter with that name and parse it to JSON and return the result
 * object. If anything goes wrong, an empty object will be returned.
 * @param {Object} req 
 * @param {String} paramName
 */
function getRequestedParams(req, paramName = "sim") {
    return decodeArgs(req.params[paramName]);
}

/**
 * Promisified version of readFile
 * @param {String} path 
 * @param {Object} options 
 */
async function readFile(path, options = null)
{
    return new Promise((resolve, reject) => {
        FS.readFile(path, options, (error, result) => {
            if (error) {
                return reject(error);
            }
            resolve(result);
        });
    });
}

/**
 * Parses the given json string into a JSON object. Internally it uses the
 * JSON.parse() method but adds three things to it:
 * 1. Returns a promise
 * 2. Ensures async result
 * 3. Catches errors and rejects the promise
 * @param {String} json The JSON input string
 * @return {Promise<Object>} Promises an object
 * @todo Investigate if we can drop the try/catch block and rely on the built-in
 *       error catching.
 */
async function parseJSON(json)
{
    return new Promise((resolve, reject) => {
        setImmediate(() => {
            let out;
            try {
                out = JSON.parse(json);
            }
            catch (error) {
                return reject(error);
            }
            resolve(out);
        });
    });
}

/**
 * Serializes the given object into json if possible. Internally it uses the
 * JSON.stringify() method but adds three things to it:
 * 1. Returns a promise
 * 2. Ensures async result
 * 3. Catches errors and rejects the promise
 * @param {Object} json The JSON input object
 * @param {Function} replacer The JSON.stringify replacer function
 * @param {Number|String} indentation The The JSON.stringify indentation
 * @return {Promise<String>} Promises a string
 * @todo Investigate if we can drop the try/catch block and rely on the built-in
 *       error catching.
 * @param json 
 */
async function stringifyJSON(json, replacer = null, indentation = null)
{
    return new Promise((resolve, reject) => {
        setImmediate(() => {
            let out;
            try {
                out = JSON.stringify(json, replacer, indentation);
            }
            catch (error) {
                return reject(error);
            }
            resolve(out);
        });
    });
}

/**
 * Read a file and parse it as JSON.
 * @param path
 * @param {Object} options The options for readFile
 * @return {Promise<Object>} Promises the JSON object
 */
async function readJSON(path, options = null)
{
    return readFile(path, options).then(parseJSON);
}

async function forEachFile(options, cb)
{
    options = Object.assign({
        dir        : ".",
        filter     : null,
        followLinks: false,
        limit      : 0
    }, options);

    return new Promise((resolve, reject) => {
        const walker = Walker.walk(options.dir, {
            followLinks: options.followLinks
        });

        let i = 0;

        walker.on("errors", (root, nodeStatsArray, next) => {
            reject(
                new Error("Error: " + nodeStatsArray.error + root + " - ")
            );
            next();
        });

        walker.on("end", () => resolve() );

        walker.on("file", (root, fileStats, next) => {
            let path = Path.resolve(root, fileStats.name);
            if (options.filter && !options.filter(path)) {
                return next();
            }
            if (options.limit && ++i > options.limit) {
                return next();
            }
            cb(path, fileStats, next);
        });
    });
}

/**
 * Walks thru an object (ar array) and returns the value found at the
 * provided path. This function is very simple so it intentionally does not
 * support any argument polymorphism, meaning that the path can only be a
 * dot-separated string. If the path is invalid returns undefined.
 * @param {Object} obj The object (or Array) to walk through
 * @param {String} path The path (eg. "a.b.4.c")
 * @returns {*} Whatever is found in the path or undefined
 */
function getPath(obj, path = "")
{
    return path.split(".").reduce((out, key) => out ? out[key] : undefined, obj)
}

function die(error="Unknown error")
{
    console.log("\n"); // in case we have something written to stdout directly
    console.error(error);
    process.exit(1);
}

function operationOutcome(
    res,
    message,
    {
        httpCode  = 500,
        issueCode = "processing", // http://hl7.org/fhir/valueset-issue-type.html
        severity  = "error"       // fatal | error | warning | information
    } = {}
)
{
    return res.status(httpCode).json({
        "resourceType": "OperationOutcome",
        "text": {
            "status": "generated",
            "div": `<div xmlns="http://www.w3.org/1999/xhtml">` +
            `<h1>Operation Outcome</h1><table border="0"><tr>` +
            `<td style="font-weight:bold;">ERROR</td><td>[]</td>` +
            `<td><pre>${htmlEncode(message)}</pre></td></tr></table></div>`
        },
        "issue": [
            {
                "severity"   : severity,
                "code"       : issueCode,
                "diagnostics": message
            }
        ]
    });
}

// require a valid auth token if there is an auth token
function checkAuth(req, res, next)
{
    if (req.headers.authorization) {
        let token;
        try {
            token = jwt.verify(
                req.headers.authorization.split(" ")[1],
                config.jwtSecret
            );
        } catch (e) {
            return res.status(401).send(
                `${e.name || "Error"}: ${e.message || "Invalid token"}`
            );
        }
        let error = token.err || token.sim_error || token.auth_error;
        if (error) {
            return res.status(401).send(error);
        }
    }
    next();
}

function getErrorText(name, ...rest)
{
    return printf(config.errors[name], ...rest);
}

function replyWithError(res, name, code = 500, ...params)
{
    return res.status(code).send(getErrorText(name, ...params));
}

/**
 * Simplified version of printf. Just replaces all the occurrences of "%s" with
 * whatever is supplied in the rest of the arguments. If no argument is supplied
 * the "%s" token is left as is.
 * @param {String} s The string to format
 * @param {*} ... The rest of the arguments are used for the replacements
 * @return {String}
 */
function printf(s)
{
    var args = arguments, l = args.length, i = 0;
    return String(s || "").replace(/(%s)/g, a => ++i > l ? "" : args[i]);
}

function buildUrlPath(...segments)
{
    return segments.map(
        s => String(s)
            .replace(/^\//, "")
            .replace(/\/$/, "")
    ).join("\/");
}

function parseToken(token)
{
    if (typeof token != "string") {
        throw new Error("The token must be a string");
    }

    token = token.split(".");

    if (token.length != 3) {
        throw new Error("Invalid token structure");
    }

    return JSON.parse(new Buffer(token[1], "base64").toString("utf8"));
}

function wait(ms = 0) {
    return new Promise(resolve => {
        if (ms) {
            setTimeout(resolve, ms);
        }
        else {
            setImmediate(resolve);
        }
    });
}

function uInt(x, defaultValue = 0) {
    x = parseInt(x + "", 10);
    if (isNaN(x) || !isFinite(x) || x < 0) {
        x = uInt(defaultValue, 0);
    }
    return x;
}

/**
 * @see https://momentjs.com/docs/#/parsing/ for the possible date-time
 * formats.
 * 
 * A dateTime string can be in any of the following formats in SQLite:
 *  YYYY-MM-DD
 *  YYYY-MM-DD HH:MM
 *  YYYY-MM-DD HH:MM:SS
 *  YYYY-MM-DD HH:MM:SS.SSS
 *  YYYY-MM-DDTHH:MM
 *  YYYY-MM-DDTHH:MM:SS
 *  YYYY-MM-DDTHH:MM:SS.SSS
 *  now
 *  DDDDDDDDDD
 */
function fhirDateTime(dateTime) {
    let t;

    dateTime = String(dateTime || "").trim();

    // YYYY (FHIR)
    if (/^\d{4}$/.test(dateTime)) dateTime += "-01-01";

    // YYYY-MM (FHIR)
    else if (/^\d{4}-\d{2}$/.test(dateTime)) dateTime += "-01";

    // TIMESTAMP
    else if (/^\d{9,}(\.\d+)?/.test(dateTime)) dateTime *= 1;

    // Parse
    t = moment(dateTime);

    if (!t.isValid()) {
        throw new Error(`Invalid dateTime "${dateTime}"`);
    }

    return t.format("YYYY-MM-DD HH:mm:ss");
}

module.exports = {
    htmlEncode,
    readFile,
    parseJSON,
    stringifyJSON,
    readJSON,
    forEachFile,
    getPath,
    operationOutcome,
    checkAuth,
    getErrorText,
    printf,
    buildUrlPath,
    replyWithError,
    parseToken,
    bool,
    wait,
    uInt,
    decodeArgs,
    getRequestedParams,
    fhirDateTime
};