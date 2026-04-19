const https = require('https');
const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, 'vendor');

const dependencies = [
    { name: 'alpine-collapse.js', url: 'https://cdn.jsdelivr.net/npm/@alpinejs/collapse@3.x.x/dist/cdn.min.js' },
    { name: 'jsqr.js', url: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js' },
    { name: 'font-awesome.css', url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css' },
    // MediaPipe Face Mesh Binaries
    { name: 'face_mesh.js', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.js' },
    { name: 'face_mesh_solution_simd_wasm_bin.js', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh_solution_simd_wasm_bin.js' },
    { name: 'face_mesh_solution_wasm_bin.js', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh_solution_wasm_bin.js' },
    { name: 'face_mesh.binarypb', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.binarypb' },
    // MediaPipe Selfie Segmentation Binaries
    { name: 'selfie_segmentation.js', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/selfie_segmentation.js' },
    { name: 'selfie_segmentation_solution_simd_wasm_bin.js', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/selfie_segmentation_solution_simd_wasm_bin.js' },
    { name: 'selfie_segmentation_solution_wasm_bin.js', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/selfie_segmentation_solution_wasm_bin.js' },
    { name: 'selfie_segmentation.tflite', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/selfie_segmentation.tflite' },
    { name: 'selfie_segmentation_landscape.tflite', url: 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1/selfie_segmentation_landscape.tflite' }
];

// FontAwesome Webfonts (Required for icons to show offline)
const FONTS_DIR = path.join(__dirname, 'webfonts');
if (!fs.existsSync(FONTS_DIR)) fs.mkdirSync(FONTS_DIR, { recursive: true });
const fontFiles = ['fa-solid-900.woff2', 'fa-brands-400.woff2', 'fa-regular-400.woff2'];

if (!fs.existsSync(VENDOR_DIR)) fs.mkdirSync(VENDOR_DIR, { recursive: true });

console.log("🚀 Starting dependency download for air-gapped PWA...");

dependencies.forEach(dep => {
    const filePath = path.join(VENDOR_DIR, dep.name);
    const file = fs.createWriteStream(filePath);

    https.get(dep.url, (response) => {
        if (response.statusCode !== 200) {
            console.error(`❌ Failed to download ${dep.name}: ${response.statusCode}`);
            return;
        }
        response.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log(`✅ Downloaded: ${dep.name}`);
        });
    }).on('error', (err) => {
        fs.unlink(filePath, () => {});
        console.error(`❌ Error downloading ${dep.name}: ${err.message}`);
    });
});

fontFiles.forEach(file => {
    const filePath = path.join(FONTS_DIR, file);
    const out = fs.createWriteStream(filePath);
    https.get(`https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/${file}`, (res) => {
        res.pipe(out);
        out.on('finish', () => console.log(`✅ Downloaded Font: ${file}`));
    });
});

/**
 * NOTE: For FontAwesome and MediaPipe, you manually need to download 
 * the /webfonts/ folder and the .wasm model files respectively 
 * as they are loaded dynamically and cannot be captured by a simple GET.
 */