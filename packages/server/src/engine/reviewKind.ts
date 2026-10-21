const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
/** What a person reviews by eye or ear (f5): images, sounds a sound worker made, models a 3D worker made. */
const AUDIO_FILE = /\.(mp3|wav|ogg|flac|m4a|aac)$/i;
const MODEL_FILE = /\.(glb|gltf|obj|fbx)$/i;
export const reviewKind = (path: string): 'image' | 'audio' | 'model' | undefined => IMAGE_FILE.test(path) ? 'image' : AUDIO_FILE.test(path) ? 'audio' : MODEL_FILE.test(path) ? 'model' : undefined;
