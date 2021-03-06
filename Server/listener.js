require("dotenv").config();

const http = require("http");
const port = 3000;

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const request = require("request");
const vision = require("@google-cloud/vision");
const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
const lang = require('language-classifier');
const drawing = require("pngjs-draw");
const png = drawing(require("pngjs").PNG);
//if this is put on a different computer, you must set options (they are in local variables on mine)
const client = new vision.ImageAnnotatorClient();
const app = express();
const PImage = require("pureimage");
const path = require("path");

app.use(bodyParser.json({limit: "50mb", extended: true}));
app.use(bodyParser.text({limit:"50mb", extended:true}));

const average = arr => arr.reduce( ( p, c ) => p + c, 0 ) / arr.length;

//contacts google vision API and gets results of document text detection
async function parseTextVision(img) {
  var request = {
    "image": {
      "content": img
    }
  };

  var results = await client.documentTextDetection(request);
  return results;
}

async function parseLabelVision(img) {
  var request = {
    "image": {
      "content": img
    }
  };

  var results = await client.labelDetection(request);
  return results;
}

//encodes image as base 64
function encodeImage(filePath) {
  var bitmap = fs.readFileSync(filePath);
  var encoded = new Buffer(bitmap).toString("base64");
  return encoded;
}

async function getVisionResults(img) {
  var visionTextResults = await parseTextVision(img);
  var visionLabelResults = await parseLabelVision(img);
  var visionResults = {
    "text": visionTextResults,
    "label": visionLabelResults
  };
  console.log("got vision results");
  jsonString = JSON.stringify(visionResults);
  fs.writeFile("results.json", jsonString, "utf8");
}


//levenshtein algorithm (from wikipedia)
function lev(a, b, i, j) {
  if (Math.min(i, j) == 0) {
    return Math.max(i, j);
  } else {
    var arg1 = lev(a, b, i-1, j) + 1;
    var arg2 = lev(a, b, i, j-1) + 1;
    var arg3 = lev(a, b, i-1, j-1) + (a[i] != b[j]);
    return Math.min(arg1, arg2, arg3);
  }
}


function levenshteinDistance (s, t) {
    if (!s.length) return t.length;
    if (!t.length) return s.length;

    return Math.min(
        levenshteinDistance(s.substr(1), t) + 1,
        levenshteinDistance(t.substr(1), s) + 1,
        levenshteinDistance(s.substr(1), t.substr(1)) + (s[0] !== t[0] ? 1 : 0)
    ) + 1;
}

function stringdist(a, b) {
  return lev(a, b, a.length, b.length);
}


function getSpaceSize(words, xDiffs){
  let spaceDiffs = [];
  for (var i = 0; i < words.length; i++) {
    if (xDiffs[i].length > 1) {
      averageXDiff = average(xDiffs[i]);
      for (var j = 0; j < xDiffs[i].length; j++) {
        if (xDiffs[i][j] >= averageXDiff) {
          spaceDiffs.push(xDiffs[i][j]);
        }
      }
    }
  }
  return average(spaceDiffs);
}

function categorize(lst, thresh) {
  if (lst.length ==1) {
    return [lst];
  }

  let avg = average(lst);

  let midIndex = lst.findIndex(function(num) {
    return num > avg;
  }) - 1;

  let lowerList = lst.slice(0, midIndex+1);
  let upperList = lst.slice(midIndex+1, lst.length+1);

  let lowerAvg = average(lowerList);
  let upperAvg = average(upperList);
  if(upperAvg - lowerAvg > thresh) {
    return categorize(lowerList, thresh).concat(categorize(upperList, thresh));
  } else {
    return [lst];
  }
}

function arrayDiff(arr) {
  diffs = [];
  for(var i = 1; i < arr.length; i++) {
    diffs.push(arr[i]-arr[i-1]);
  }
  return diffs;
}

function getLineTabGroups(lineStarts, threshold){


  if (lineStarts.length == 1) {
    return [lineStarts];
  }
  //console.log("Line starts: " + lineStarts);

  let avgStart = average(lineStarts.map(x => {return x[0]}));

  let midIndex = lineStarts.findIndex(function(number) {
    return number[0] > avgStart;
  }) - 1;

  let lowerList = lineStarts.slice(0, midIndex + 1);
  let upperList = lineStarts.slice(midIndex + 1, lineStarts.length + 1);

  // console.log("average to split on: " + avgStart);
  // console.log("lower list");
  // console.log(lowerList.sort((a,b)=>a-b));
  // console.log("upper list");
  // console.log(upperList.sort((a,b)=>a-b));

  let lowerAvg = average(lowerList.map(x => {return x[0]}));
  let upperAvg = average(upperList.map(x => {return x[0]}));



  if (upperAvg - lowerAvg > threshold) {
    // console.log("different enough");
    return getLineTabGroups(lowerList, threshold).concat(getLineTabGroups(upperList, threshold))
  }
  else {
    // console.log("not different enough");
    // base case
    return [lineStarts];
  }
}

function getCenter(char) {
  return [average(char.boundingBox.vertices.map(v=>v.x)), average(char.boundingBox.vertices.map(v=>v.y))];
}

function slantDetection(visionResults) {
  var fullAnnotation = visionResults[0].fullTextAnnotation;
  // console.log(visionResults[0].textAnnotations[0].description);
  var slants = [];
  var words = [];
  var lines = [];
  for (var p = 0; p < fullAnnotation.pages.length; p++) {
    for (var b = 0; b < fullAnnotation.pages[p].blocks.length; b++) {
      for (var r = 0; r < fullAnnotation.pages[p].blocks[b].paragraphs.length; r++) {
        // console.log(fullAnnotation.pages[p].blocks[b].paragraphs[r].words.map(function(w) {return w.symbols.map((s)=>s.text).join("")}).join(" "));
        for (var w = 0; w < fullAnnotation.pages[p].blocks[b].paragraphs[r].words.length; w++) {
          var word = fullAnnotation.pages[p].blocks[b].paragraphs[r].words[w];
          // console.log(word.symbols.map((s)=>s.text).join(""));
          if(word.symbols.length > 4) {
            var first_char = word.symbols[0];
            var last_char = word.symbols[word.symbols.length - 1];
            var first_char_center = getCenter(first_char);
            var last_char_center = getCenter(last_char);
            lines.push([...first_char_center,...last_char_center].map((d)=>Math.round(d)));
            var slant = (last_char_center[1]-first_char_center[1])/(last_char_center[0]-first_char_center[0]);
            var angle = Math.atan(slant);
            slants.push(angle);
          }
          var wordString = word.symbols.map(s => s.text).join("");
          var wordObject = JSON.parse(JSON.stringify(word));
          wordObject["text"] = wordString;
          words.push(wordObject);
        }
      }
    }
  }
  return {
    "slant": average(slants),
    "words": words,
    "lines": lines
  };
}

function xDifference(slant, arr) {
  var diffs = [];
  for (var i = 1; i < arr.length; i++) {
    var thisX = translateCoordinates(slant, getCenter(arr[i].symbols[0]))[0];
    var lastX = translateCoordinates(slant, getCenter(arr[i-1].symbols[arr[i-1].symbols.length-1]))[0];
    diffs.push(thisX-lastX);
  }
  return diffs;
}

function arrayDivide(arr, d) {
  var div = [];
  for (var i = 0; i < arr.length; i++) {
    div.push(arr[i]/d);
  }
  return div;
}

function arrayFunc(arr, f) {
  var funced = [];
  for (var i = 0; i < arr.length; i++) {
    funced.push(f(arr[i]));
  }
  return funced;
}

function stddev(arr) {
  var avg = average(arr);
  var diffs = arr.map(v => v - avg);
  var squareDiffs = diffs.map(x => x*x);
  var averageSquareDiff = average(squareDiffs);
  return Math.sqrt(averageSquareDiff);
}

function arrangeWords(visionResults) {

  var slantResults = slantDetection(visionResults);


  var BUILD_DIR = "/Users/georgiashay/Documents/0Projects/HackMIT/Whiteboard/hackmit2018/Server/";
  PImage.decodeJPEGFromStream(fs.createReadStream("currentIMG.jpg")).then((img) => {
      // console.log("size is",img.width,img.height);
      var img2 = PImage.make(img.width,img.height);
      var c = img2.getContext('2d');
      c.drawImage(img);
      // c.drawLine({start: {x: 0, y: 0}, end: {x: 1000, y:1000}});
      c.strokeStyle = 'rgba(255, 0, 0, 2)'
      c.lineWidth = 10;
      for(var i = 0; i < slantResults.lines.length; i++) {
        var l = slantResults.lines[i];
        c.drawLine({start: {x: l[0], y: l[1]}, end: {x: l[2], y: l[3]}});
      }
      var pth = path.join(BUILD_DIR,"annotatedIMG.jpg");
      PImage.encodeJPEGToStream(img2,fs.createWriteStream(pth)).then(() => {
          console.log("done writing");
      });
  });

  // var fullText = visionResults[0].textAnnotations[0].description;

  var slant = slantResults.slant;
  var words = slantResults.words;

  var textAnnotations = visionResults[0].textAnnotations;

  var translatedYs = [];
  var xDiffs = [[]];
  var xDiffsFlat = []
  for(var w = 0; w < words.length; w++) {
    translatedYs.push([translateCoordinates(slant, getCenter(words[w].symbols[0]))[1],w,words[w].text,getCenter(words[w].symbols[0])[1]]);
  }

  translatedYs.sort(function(a,b) {return a[0]-b[0]});
  for(var t = 1; t < textAnnotations.length-1; t++) {
    //not quite accurate with translation - bc we are just picking a corner, and we need to do that smarter
    var thisWord = translateCoordinates(slant, [textAnnotations[t].boundingPoly.vertices[1].x, textAnnotations[t].boundingPoly.vertices[1].y]);
    var nextWord = translateCoordinates(slant, [textAnnotations[t+1].boundingPoly.vertices[0].x, textAnnotations[t+1].boundingPoly.vertices[0].y]);

    if (!(nextWord[0] < thisWord[0] && nextWord[1] > thisWord[1])) {
      xDiffsFlat.push(nextWord[0] - thisWord[0]);
    }
  }

  console.log(translatedYs);
  var categorizedLines = getLineTabGroups(translatedYs, average(xDiffsFlat));

  for (var c = 0; c < categorizedLines.length; c++) {
    categorizedLines[c].sort(function(a,b) {
       var aT = translateCoordinates(slant, getCenter(words[a[1]].symbols[0]))[0];
       var bT = translateCoordinates(slant, getCenter(words[b[1]].symbols[0]))[0];
       return aT-bT;
     });
    categorizedLines[c] = categorizedLines[c].map(a => words[a[1]]);
  }

  // console.log(categorizedLines.map(c=>c.map(a=>a.text)));



  for (var l = 0; l < categorizedLines.length; l++) {
    for (var i = 0; i < categorizedLines[l].length; i++) {
    }
  }


  var lineStarts = [];
  for (var c = 0; c < categorizedLines.length; c++) {
    lineStarts.push(translateCoordinates(slant, getCenter(categorizedLines[c][0].symbols[0]))[0]);
  }



  var xDiffs = categorizedLines.map(line => xDifference(slant, line));
  var mappedLines = lineStarts.map((element, index) => {return [element, index]}).sort((a, b) => { return a[0] - b[0]});
  var averageSpace = 1.5*getSpaceSize(categorizedLines, xDiffs);
  let lineTabGroups = getLineTabGroups(mappedLines, averageSpace);
  let lineTabs = new Array(lineStarts.length);
  for (var i = 0; i < lineTabGroups.length; i++){
    for (var j = 0; j < lineTabGroups[i].length; j++){
      lineTabs[lineTabGroups[i][j][1]] = i;
    }
  }

  var wordStrings = [];



  // loop through each line of text
  for (var i = 0; i < categorizedLines.length; i++) {
    var wordString = "";
    // attach necessary number of tabs
    for (var t = 0; t < lineTabs[i]; t++){
      wordString += "\t";
    }
    // check if there's more than 2 words left in the line
    if (xDiffs[i].length > 1) {
      wordString += categorizedLines[i][0].text;
      averageXDiff = average(xDiffs[i]);
      for (var j = 0; j < xDiffs[i].length; j++) {
        if (xDiffs[i][j] < averageXDiff) {
          wordString += categorizedLines[i][j+1].text;
        } else {
          wordString += " " + categorizedLines[i][j+1].text;
        }
      }


      wordStrings.push(wordString);
    } else {
      wordStrings.push(wordString + categorizedLines[i].map(c=>c.text).join(" "));
    }
  }
  //uncomment this
  // console.log(wordStrings.join("\n"));
  return wordStrings.join("\n");


}

function translateCoordinates(theta, point) {
  //var theta = Math.atan(slant);
  var xPrime = point[0] * Math.cos(theta) + point[1] * Math.sin(theta);
  var yPrime = point[1] * Math.cos(theta) - point[0] * Math.sin(theta);
  return [xPrime, yPrime];
}


//fixes camel case and tabbing in vision results
function fixCamelCase(visionResults, labelResults) {
  //words is a 2d array - rows are lines, each there are words in each line
  //start words with the first word in the first line
  //var xBox = visionResults[0].textAnnotations[0].boundingPoly.vertices
  var slant = slantDetection(visionResults);
  // console.log("slant: " + slant.slant);
  for (var w = 0; w < slant.words.length; w++) {
    // console.log(slant.words[w].text);
  }

  arrangeWords(visionResults);

  // var words = [[visionResults[0].textAnnotations[1].description]];
  // var wordsIndex = 0;
  // var xDiffs = [[]];
  // //the beginning of each line
  // var lineStarts = [visionResults[0].textAnnotations[1].boundingPoly.vertices[0].x];
  // //
  // for (var i = 1; i < visionResults[0].textAnnotations.length-1; i++) {
  //   var thisAnnotation = visionResults[0].textAnnotations[i];
  //   var nextAnnotation = visionResults[0].textAnnotations[i+1];
  //   xDifference = nextAnnotation.boundingPoly.vertices[0].x - thisAnnotation.boundingPoly.vertices[1].x;
  //   yDifference = nextAnnotation.boundingPoly.vertices[0].y - thisAnnotation.boundingPoly.vertices[0].y;
  //   if (xDifference < 0 && yDifference > 0) {
  //     wordsIndex++;
  //     words.push([]);
  //     xDiffs.push([]);
  //     lineStarts.push(nextAnnotation.boundingPoly.vertices[0].x);
  //   } else {
  //     xDiffs[wordsIndex].push(xDifference);
  //   }
  //   words[wordsIndex].push(nextAnnotation.description);
  // }
  //
  // let lineTabGroups = getLineTabGroups(lineStarts.map((element, index) => {return [element, index]}).sort((a, b) => { return a[0] - b[0]}), 1.5*getSpaceSize(words, xDiffs));
  // let lineTabs = new Array(lineStarts.length);
  // for (var i = 0; i < lineTabGroups.length; i++){
  //   for (var j = 0; j < lineTabGroups[i].length; j++){
  //     lineTabs[lineTabGroups[i][j][1]] = i;
  //   }
  // }
  //
  //
  // var wordStrings = [];
  //
  // // loop through each line of text
  // for (var i = 0; i < words.length; i++) {
  //
  //   var wordString = "";
  //   // attach necessary number of tabs
  //   for (var t = 0; t < lineTabs[i]; t++){
  //     wordString += "\t";
  //   }
  //   // check if there's more than 2 words left in the line
  //   if (xDiffs[i].length > 1) {
  //     wordString += words[i][0];
  //     averageXDiff = average(xDiffs[i]);
  //     for (var j = 0; j < xDiffs[i].length; j++) {
  //       if (xDiffs[i][j] < averageXDiff) {
  //         wordString += words[i][j+1];
  //       } else {
  //         wordString += " " + words[i][j+1];
  //       }
  //     }
  //
  //
  //     wordStrings.push(wordString);
  //   } else {
  //     wordStrings.push(wordString + words[i].join(" "));
  //   }
  // }
  // //uncomment this
  // //console.log(wordStrings.join("\n"));
  // return wordStrings.join("\n");
  return "hello";
}



async function fromFile(fileName) {
  fs.readFile(fileName, "base64", async function readFileCallback(err, encodedImage) {
    var visionAPIResults = await parseTextVision(encodedImage);
    var labelAPIResults = await parseLabelVision(encodedImage);
    var codeString = fixCamelCase(visionAPIResults, labelAPIResults);
    console.log(codeString);
  })

}

fromFile("currentIMG.png");

// fs.readFile("results.json", "utf8", function readFileCallback(err, data) {
//   if(err) {
//     console.log(err);
//   } else {
//     var visionResults = JSON.parse(data);
//     outputString = fixCamelCase(visionResults);
//     console.log(outputString);
//     console.log(lang(outputString));
//   }
// });

function sendCode(codeString, codeLang, targetAddress) {
  var options = {
    hostname: targetAddress,
    port: 8080,
    path: "/code",
    method: "POST",
    // headers: {
    //     "Content-Disposition": "attachment; filename=code.txt",
    //     "Content-Type": "text/plain"
    // }
    headers: {
      "Content-Type": "text/plain"
    }
  };

  var req = http.request(options, function(res) {
    //console.log(res);
  });

  req.write(JSON.stringify({code: codeString, lang: codeLang}));
  req.end();
}

//sendCode("thing", "192.168.43.54");

app.post("/image", async function(req, res) {
  var imgObject = JSON.parse(req.body);

  var encodedImage = imgObject.img;

  fs.writeFile("currentIMG.png", encodedImage, "base64");

  var targetAddress = imgObject.ip;

  // console.log(encodedImage);
  // console.log(targetAddress);

  var visionAPIResults = await parseTextVision(encodedImage);
  var labelAPIResults = await parseLabelVision(encodedImage);
  var codeString = fixCamelCase(visionAPIResults, labelAPIResults);
  var codeLang = "";
  if( codeString.indexOf("{") > -1 ) {
    codeLang = "C";
  } else {
    codeLang = "Python";
  }
  console.log(codeLang);
  sendCode(codeString, codeLang, targetAddress);
});

app.get("/test", function(req, res) {
  res.json({"Message": "Test successful"})
})


app.listen(8080);
