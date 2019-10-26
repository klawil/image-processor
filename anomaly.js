var jimp = require('jimp');
var argv = require('yargs').argv;
var fs = require('fs');
var path = require('path');

// Get the parameters
var pathToUse = argv.input;
var output = argv.output || null;
var blur = argv.b || 1;
var range = argv.r || 1;
var outlier = argv.m || 0;
var invert = argv.i;
var parallelism = argv.p || 1;

var activeImages = 0;
var activeIndex = 0;

// Check for a file vs a directory
if (fs.lstatSync(pathToUse).isFile()) {
  if (output === null) {
    output = path.dirname(pathToUse);
  }

  parseImage(pathToUse);
} else {
  if (output === null) {
    output = pathToUse;
  }

  var filesToParse = fs.readdirSync(pathToUse);

  startImages();
}

function fileParseCallback(filename, start, error) {
  console.log(filename + ': ' + (((new Date()).getTime() - start) / 1000) + 's');
  if (error)
    console.log(error);

  activeImages--;

  startImages();
}

function startImages() {
  while (activeImages < parallelism && activeIndex < filesToParse.length) {
    activeIndex++;
    activeImages++;
    startImage(filesToParse[activeIndex - 1]);
  }
}

function startImage(file) {
  var start = (new Date()).getTime();
  var extension = path.extname(file).toLowerCase();
  if (['.jpg', '.png'].indexOf(extension) === -1) {
    fileParseCallback(file, start, 'Not an image (' + extension + ')');
    return;
  }
  var callback = fileParseCallback.bind(undefined, file, start);

  try {
    parseImage(pathToUse + '/' + file, callback);
  } catch (e) {
    callback(e);
  }
}

function parseImage(imageToParse, callback) {
  // Start the performance measuring
  var performanceArray = [];
  addPerformanceItem('load image', performanceArray, callback);

  // Load the image
  jimp.read(imageToParse, function(error, image) {
    addPerformanceItem('get pixel values', performanceArray, callback);

    if (error) {
      if (typeof callback !== 'undefined') {
        callback(error);
      } else {
        throw error;
      }
      return;
    }

    // Initialize the change array
    var imagePixelArray = [];
    // Loop through all of the pixels and create an array
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, index) {
      // Check for definition
      if (typeof imagePixelArray[x] === 'undefined') {
        imagePixelArray[x] = [];
      }

      // Set the value
      imagePixelArray[x][y] = [
        this.bitmap.data[index],
        this.bitmap.data[index + 1],
        this.bitmap.data[index + 2],
        this.bitmap.data[index + 3],
      ];
    });
    image = null;

    // Blur the values into an average if needed
    if (blur > 1) {
      addPerformanceItem('blur the image', performanceArray, callback);

      var rawImagePixelArray = imagePixelArray;
      imagePixelArray = [];

      for (var xStart = 0; xStart < rawImagePixelArray.length; xStart += blur) {
        imagePixelArray[xStart / blur] = [];

        for (var yStart = 0; yStart < rawImagePixelArray[xStart].length; yStart += blur) {
          // Loop through the rows associated
          var sums = [
            0,
            0,
            0,
            0,
          ];
          var count = 0;
          for (var x = xStart; x < xStart + blur; x++) {
            for (var y = yStart; y < yStart + blur; y++) {
              // Check for this existing
              if (typeof rawImagePixelArray[x] === 'undefined' || typeof rawImagePixelArray[x][y] === 'undefined') {
                continue;
              }

              // Add to the count
              count++;

              // Add to the sums
              sums[0] += rawImagePixelArray[x][y][0];
              sums[1] += rawImagePixelArray[x][y][1];
              sums[2] += rawImagePixelArray[x][y][2];
              sums[3] += rawImagePixelArray[x][y][3];
            }
          }

          // Calculate the average
          if (count === 0) {
            sums = [
              0,
              0,
              0,
              0,
            ];
          } else {
            sums[0] = Math.round(sums[0] / count);
            sums[1] = Math.round(sums[1] / count);
            sums[2] = Math.round(sums[2] / count);
            sums[3] = Math.round(sums[3] / count);
          }

          imagePixelArray[xStart / blur][yStart / blur] = sums;
        }
      }
      rawImagePixelArray = null;
    }

    addPerformanceItem('get image difference values', performanceArray, callback);

    // Check for differences by looking at the surrounding pixels
    var maxDifference = 0;
    var minDifference = 1E10;
    var imageDiffArray = [];
    imagePixelArray.forEach(function(row, x) {
      row.forEach(function(value, y) {
        // Calculate the difference between each surrounding pixel in a 3x3 square
        var difference = 0;
        var compareCount = 0;

        // Loop through the possible coordinates
        for (var x_c = x - range; x_c <= x + range; x_c++) {
          for (var y_c = y - range; y_c <= y + range; y_c++) {
            // Check for it being the current pixel
            if (x_c === x && y_c === y) {
              continue;
            }

            // Check for the row being defined
            if (typeof imagePixelArray[x_c] === 'undefined') {
              continue;
            }

            // Check for the pixel being defined
            if (typeof imagePixelArray[x_c][y_c] === 'undefined') {
              continue;
            }

            // Compute the difference
            difference += compareVectors(value, imagePixelArray[x_c][y_c]);

            // Add to the count
            compareCount++;
          }
        }

        // Calculate the difference
        if (compareCount === 0) {
          difference = 0;
        } else {
          difference = difference / compareCount;
        }

        // Check for record highs or lows
        if (difference > maxDifference) {
          maxDifference = difference;
        }
        if (difference < minDifference) {
          minDifference = difference;
        }

        // Save the difference
        if (typeof imageDiffArray[x] === 'undefined') {
          imageDiffArray[x] = [];
        }
        imageDiffArray[x][y] = difference;
      });
    });
    imagePixelArray = null;

    addPerformanceItem('create new image values', performanceArray, callback);

    // Make a new image with the change on it
    var counts = [];
    var pixels = [];
    var sum = 0;
    var count = 0;
    image = new jimp(imageDiffArray.length, imageDiffArray[0].length);
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function(x, y, index) {
      // Get the value to use
      var difference;
      if (typeof imageDiffArray[x] === 'undefined' || typeof imageDiffArray[x][y] === 'undefined') {
        difference = maxDifference;
        console.log(x, y);
      } else {
        difference = imageDiffArray[x][y];
      }

      // Make the difference a scale of 0-255
      var value = Math.round(((difference - minDifference) / (maxDifference - minDifference)) * 255);

      if (typeof invert === 'undefined') {
        value = 255 - value;
      }

      if (value >= outlier) {
        pixels.push([x, y]);
      }

      if (typeof counts[value] === 'undefined') {
        counts[value] = 0;
      }
      counts[value]++;
      sum += value;
      count++;

      // Set the values
      image.bitmap.data[index] = value;
      image.bitmap.data[index + 1] = value;
      image.bitmap.data[index + 2] = value;
      image.bitmap.data[index + 3] = 255;
    });

    if (outlier > 0) {
      addPerformanceItem('add outlier markers', performanceArray, callback);

      pixels.forEach(function(value) {
        // Make a 2px wide border 5 pixels away
        var pixelsToChange = [];
        for (var x = value[0] - 7; x <= value[0] + 7; x++) {
          for (var y = value[1] - 7; y <= value[1] + 7; y++) {
            // Skip non-border pixels
            if ([6, 7, -6, -7].indexOf(y - value[1]) === -1 && [6, 7, -6, -7].indexOf(x - value[0]) === -1) {
              continue;
            }

            // Change the pixel colors
            try {
              var index = image.getPixelIndex(x, y);
              image.bitmap.data[index] = 255;
              image.bitmap.data[index + 1] = 0;
              image.bitmap.data[index + 2] = 0;
            } catch (e) {}
          }
        }
      });
    }

    addPerformanceItem('write the new image', performanceArray, callback);

    image
      .quality(60)
      .write(output + '/' + path.basename(imageToParse, path.extname(imageToParse)) + '-map.jpg', function(error) {
        if (error) {
          if (typeof callback !== 'undefined') {
            callback(error);
          } else {
            throw error;
          }
          return;
        }

        addPerformanceItem('total', performanceArray, callback);

        if (typeof callback !== 'undefined') {
          callback();
        } else {
          console.log(performanceArray[0][0] + ': ' + ((performanceArray[0][1] - performanceArray[performanceArray.length - 1][1]) / 1000) + 's');
        }
      });
  });
}

function addPerformanceItem(name, array, callback) {
  if (array.length > 0 && typeof callback === 'undefined') {
    console.log(array[0][0] + ': ' + (((new Date()).getTime() - array[0][1]) / 1000) + 's');
  }

  array.unshift([
    name,
    (new Date()).getTime(),
  ]);
}

function compareVectors(v1, v2) {
  return Math.sqrt(
    Math.pow(v2[0] - v1[0], 2) +
    Math.pow(v2[1] - v1[1], 2) +
    Math.pow(v2[2] - v1[2], 2) +
    Math.pow(v2[3] - v1[3], 2)
  );
}
// --> compareVectors
