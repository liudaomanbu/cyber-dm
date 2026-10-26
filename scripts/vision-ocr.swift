import Foundation
import Vision
import ImageIO
import CoreGraphics

// OCR helper used by scripts/ocr-pdf.sh on macOS. The result is review
// material only: OCR text never bypasses the upload citation checks.
let paths = Array(CommandLine.arguments.dropFirst())
guard !paths.isEmpty else {
  fputs("usage: vision-ocr.swift image...\n", stderr)
  exit(2)
}

for path in paths {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("cannot read image: \(path)\n", stderr)
    continue
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
  request.minimumTextHeight = 0.005

  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    print("[IMAGE \(path)]")
    print(lines.joined(separator: "\n"))
  } catch {
    fputs("OCR failed for \(path): \(error)\n", stderr)
  }
}
