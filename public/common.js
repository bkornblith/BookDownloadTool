'use strict'

function log(str) {
    var node = document.createElement("div")
    node.textContent = str
    logs.appendChild(node)
}
window.addEventListener("error", function (event) {
    log(event.filename + ":" + event.lineno + " " + event.message)
}, false)

function xhr(method, url, cb) {
	var x = new XMLHttpRequest()
	x.onload = function () {
		cb(x)
	}
	x.onerror = function () {
		cb(x)
	}
	x.open(method, url, true)
	x.send(null)
}

var isIOS = /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
