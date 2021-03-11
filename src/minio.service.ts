import {
  Injectable,
  Logger,
  InternalServerErrorException,
  Inject,
  NotFoundException,
  UnsupportedMediaTypeException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Response } from 'express';
import * as crypto from 'crypto';
import * as Minio from 'minio';
import { MinioConfig } from './types/minio.config.type';
import { BufferedFile } from './types/buffered-file.interface';
import { DeleteFileResponse, UploadFileResponse } from './types/response.dto';
import { IMinioService } from './types/minio-service.interface';
import { MinioOptions } from './types/minio.options.type';
import { IUploadValidator } from './types/upload-validator.interface';

@Injectable()
export class MinioService implements IMinioService {
  //region [ Constructor ]
  private readonly logger: Logger;
  private readonly service: Minio.Client;
  private readonly directAccess: boolean = false;
  private readonly directPrefix: string;
  constructor(
    @Inject('MINIO_CONFIG') private config: MinioConfig,
    @Inject('MINIO_OPTIONS') private options: MinioOptions,
  ) {
    if (this.options?.directAccessPrefix) {
      this.directAccess = true;
      this.directPrefix = this.options?.directAccessPrefix;
    }
    this.service = new Minio.Client(this.config);
    this.logger = new Logger('MinioStorageService');
  }
  //endregion

  //region [ Private Methods ]
  private static getExtension(file: BufferedFile) {
    return file.originalname.substring(
      file.originalname.lastIndexOf('.'),
      file.originalname.length,
    );
  }
  private static getBucket(url: string) {
    return url.substr(1, url.indexOf('/', 1) - 1);
  }
  private static getFileName(url: string) {
    return url.substr(url.indexOf('/', 1) + 1);
  }

  private static getRandomString() {
    const timestamp = new Date().getTime().toString();
    return crypto.createHash('md5').update(timestamp).digest('hex');
  }

  private static getRandomFileName(file: BufferedFile) {
    const ext = MinioService.getExtension(file);
    const hashedFileName = MinioService.getRandomString();
    return hashedFileName + ext;
  }

  private static getMetaData(file: BufferedFile) {
    return {
      'Content-Type': file.mimetype,
      'X-Amz-Meta-Testing': 1234,
    };
  }

  private getFileName(
    fileName: string,
    bucketValidator: string,
  ): { fileName: string; bucketName: string } {
    // remove base url if exists
    if (this.directAccess) {
      fileName = fileName.substr(this.directPrefix.length);
    }
    const realBucketName = MinioService.getBucket(fileName);
    const realFileName = MinioService.getFileName(fileName);

    // if bucket exists validate its name
    if (bucketValidator && bucketValidator !== realBucketName) {
      this.logger.error('Bucket names does not match.');
      this.logger.error(
        `Real Bucket: ${realBucketName} | Bucket Validator: ${bucketValidator}`,
      );
      throw new NotFoundException(`file ${fileName} not found`);
    }
    return { fileName: realFileName, bucketName: realBucketName };
  }

  private catchError(err: Error): never {
    this.logger.error(err.message);
    throw new InternalServerErrorException(err.message);
  }

  private async createBucket(bucket: string): Promise<void> {
    if (!(await this.service.bucketExists(bucket))) {
      await this.service.makeBucket(bucket, 'us-east-1');
    }
  }

  private async validateBeforeUpdate(
    file: BufferedFile,
    bucket: string,
    validator: IUploadValidator,
  ) {
    if (validator) {
      // MIME Validation
      if (validator.validMimes && validator.validMimes.length) {
        const list = validator.validMimes.map((item) =>
          item.toString().toLowerCase(),
        );
        if (!list.includes(file.mimetype.toLowerCase())) {
          throw new UnsupportedMediaTypeException();
        }
      }
      // Size Validation
      if (validator.maxSize) {
        if (validator.maxSize * 1000 < file.size) {
          throw new PayloadTooLargeException(
            `maximum size is set to ${validator.maxSize} kilobytes`,
          );
        }
      }
    }
    await this.createBucket(bucket);
  }
  //endregion

  //region [ Public Methods ]
  async upload(
    file: BufferedFile,
    bucket: string,
    validator: IUploadValidator = null,
  ): Promise<UploadFileResponse> {
    await this.validateBeforeUpdate(file, bucket, validator);
    const metaData = MinioService.getMetaData(file);
    const fileName = MinioService.getRandomFileName(file);
    return this.service
      .putObject(bucket, fileName, file.buffer, metaData)
      .then(() => {
        let url = `/${bucket}/${fileName}`;
        if (this.directAccess) {
          url = this.directPrefix + url;
        }
        return new UploadFileResponse(url);
      })
      .catch((err) => this.catchError(err));
  }

  async delete(
    path: string,
    bucketValidator: string,
  ): Promise<DeleteFileResponse> {
    const { fileName, bucketName } = this.getFileName(path, bucketValidator);
    await this.service.removeObject(bucketName, fileName);
    return new DeleteFileResponse(true);
  }

  async get(
    res: Response,
    path: string,
    bucketValidator: string = null,
  ): Promise<void> {
    const { fileName, bucketName } = this.getFileName(path, bucketValidator);
    try {
      const data = await this.service.getObject(bucketName, fileName);
      data.pipe(res);
    } catch (e) {
      throw new NotFoundException(`file ${path} not found`);
    }
  }
  //endregion
}
