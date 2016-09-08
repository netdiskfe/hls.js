if (typeof ArrayBuffer !== 'undefined' && !ArrayBuffer.prototype.slice) {
  ArrayBuffer.prototype.slice = function (start, end) {
    var that = new Uint8Array(this);
    if (end === undefined) {
      end = that.length;
    }
    var result = new ArrayBuffer(end - start);
    var resultArray = new Uint8Array(result);
    for (var i = 0; i < resultArray.length; i++) {
      resultArray[i] = that[i + start];
    }
    return result;
  };
}

if (typeof Uint8Array !== 'undefined' && !Uint8Array.prototype.concat) {
  Uint8Array.prototype.concat = function (...arrays) {
    let that = this;
    let totalLength = that.length;
    for (let arr of arrays) {
      totalLength += arr.byteLength;
    }
    let result = new Uint8Array(totalLength);
    let offset = 0;
    result.set(that, offset);
    offset += that.length;
    for (let arr of arrays) {
      result.set(arr, offset);
      offset += arr.byteLength;
    }
    return result;
  };
}
